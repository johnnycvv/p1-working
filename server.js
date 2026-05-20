require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// In-memory campaign state
let campaign = {
  numbers: [],
  current: 0,
  active: false,
  results: [],
  message: process.env.DEFAULT_MESSAGE || 'Hello! Press 1 now to speak with one of our team members.',
  transferTo: process.env.TRANSFER_NUMBER || '',
  callerId: process.env.TWILIO_CALLER_ID || '',
  concurrency: parseInt(process.env.CONCURRENCY || '1'),
  delayMs: parseInt(process.env.CALL_DELAY_MS || '2000'),
};

// ── Twilio Webhook: plays message when call is answered ──────────────────────
app.post('/twiml/answer', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    numDigits: 1,
    action: '/twiml/keypress',
    method: 'POST',
    timeout: 8,
    finishOnKey: '',
  });
  gather.say({ voice: 'Polly.Amy', language: 'en-GB' }, campaign.message);

  // If no key pressed, play message once more then hang up
  twiml.say({ voice: 'Polly.Amy', language: 'en-GB' }, 'We did not receive your input. Goodbye.');
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

// ── Twilio Webhook: handles keypress ────────────────────────────────────────
app.post('/twiml/keypress', (req, res) => {
  const digit = req.body.Digits;
  const callSid = req.body.CallSid;
  const to = req.body.To;
  const twiml = new twilio.twiml.VoiceResponse();

  if (digit === '1') {
    updateResult(callSid, to, 'transferred');
    twiml.say({ voice: 'Polly.Amy', language: 'en-GB' }, 'Please hold while we connect you.');
    twiml.dial({ timeout: 30, callerId: campaign.callerId || req.body.To })(campaign.transferTo);
  } else {
    updateResult(callSid, to, 'pressed_' + digit);
    twiml.say({ voice: 'Polly.Amy', language: 'en-GB' }, 'Thank you. Goodbye.');
    twiml.hangup();
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Twilio Webhook: call status callback ────────────────────────────────────
app.post('/twiml/status', (req, res) => {
  const { CallSid, CallStatus, To } = req.body;
  const terminal = ['completed', 'busy', 'no-answer', 'canceled', 'failed'];
  if (terminal.includes(CallStatus)) {
    const existing = campaign.results.find(r => r.callSid === CallSid);
    if (!existing) {
      updateResult(CallSid, To, CallStatus);
    } else if (existing.outcome === 'dialling') {
      existing.outcome = CallStatus;
      existing.updatedAt = new Date().toISOString();
    }
    // Trigger next call if campaign still active
    if (campaign.active) scheduleNext();
  }
  res.sendStatus(200);
});

function updateResult(callSid, to, outcome) {
  const existing = campaign.results.find(r => r.callSid === callSid);
  if (existing) {
    existing.outcome = outcome;
    existing.updatedAt = new Date().toISOString();
  } else {
    campaign.results.push({ callSid, to, outcome, updatedAt: new Date().toISOString() });
  }
}

// ── Place a single outbound call ─────────────────────────────────────────────
async function placeCall(number) {
  const baseUrl = process.env.BASE_URL;
  try {
    const call = await client.calls.create({
      to: number,
      from: campaign.callerId,
      url: `${baseUrl}/twiml/answer`,
      statusCallback: `${baseUrl}/twiml/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed', 'busy', 'no-answer', 'canceled', 'failed'],
      machineDetection: 'Enable',
      asyncAmd: 'true',
      asyncAmdStatusCallback: `${baseUrl}/twiml/amd`,
    });
    campaign.results.push({ callSid: call.sid, to: number, outcome: 'dialling', updatedAt: new Date().toISOString() });
    return call.sid;
  } catch (err) {
    campaign.results.push({ callSid: null, to: number, outcome: 'error: ' + err.message, updatedAt: new Date().toISOString() });
    return null;
  }
}

// ── AMD callback: hang up if answering machine detected ──────────────────────
app.post('/twiml/amd', (req, res) => {
  const { AnsweredBy, CallSid } = req.body;
  if (AnsweredBy && AnsweredBy.includes('machine')) {
    client.calls(CallSid).update({ status: 'completed' }).catch(() => {});
    updateResult(CallSid, '', 'voicemail');
  }
  res.sendStatus(200);
});

// ── Campaign scheduler ───────────────────────────────────────────────────────
function scheduleNext() {
  if (!campaign.active || campaign.current >= campaign.numbers.length) {
    campaign.active = false;
    return;
  }
  setTimeout(async () => {
    if (!campaign.active) return;
    const number = campaign.numbers[campaign.current++];
    await placeCall(number);
    if (campaign.current < campaign.numbers.length) scheduleNext();
    else campaign.active = false;
  }, campaign.delayMs);
}

// ── API: Upload CSV ───────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('csv'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const numbers = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (row) => {
      const val = Object.values(row)[0]?.toString().trim().replace(/\s+/g, '');
      if (val && /^\+?[\d\s\-()]+$/.test(val)) numbers.push(val);
    })
    .on('end', () => {
      fs.unlinkSync(req.file.path);
      campaign.numbers = numbers;
      campaign.current = 0;
      campaign.results = [];
      campaign.active = false;
      res.json({ loaded: numbers.length, preview: numbers.slice(0, 5) });
    })
    .on('error', err => res.status(500).json({ error: err.message }));
});

// ── API: Start campaign ───────────────────────────────────────────────────────
app.post('/api/start', (req, res) => {
  const { message, transferTo, callerId } = req.body;
  if (!campaign.numbers.length) return res.status(400).json({ error: 'No numbers loaded' });
  if (!transferTo) return res.status(400).json({ error: 'Transfer number required' });
  if (!callerId) return res.status(400).json({ error: 'Caller ID required' });
  if (!process.env.BASE_URL) return res.status(400).json({ error: 'BASE_URL not set in .env' });

  campaign.message = message || campaign.message;
  campaign.transferTo = transferTo;
  campaign.callerId = callerId;
  campaign.active = true;
  campaign.current = 0;
  campaign.results = [];

  scheduleNext();
  res.json({ started: true, total: campaign.numbers.length });
});

// ── API: Stop campaign ────────────────────────────────────────────────────────
app.post('/api/stop', (req, res) => {
  campaign.active = false;
  res.json({ stopped: true });
});

// ── API: Status ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    active: campaign.active,
    total: campaign.numbers.length,
    dialled: campaign.current,
    remaining: Math.max(0, campaign.numbers.length - campaign.current),
    results: campaign.results,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Press-1 dialler running on port ${PORT}`));
