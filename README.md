# Press-1 Auto Dialler → 3CX Transfer

Autodials a list of numbers from a CSV, plays a short message, and transfers anyone who presses 1 to your 3CX call centre.

---

## Requirements

- Node.js 18+
- A **Twilio** account (trial works, but you need a verified number)
- Your **3CX** SIP URI or PSTN transfer number
- A **publicly accessible URL** for Twilio webhooks — use [ngrok](https://ngrok.com) for local dev

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | From Twilio Console → Account Info |
| `TWILIO_AUTH_TOKEN` | From Twilio Console → Account Info |
| `TWILIO_CALLER_ID` | Your Twilio phone number e.g. `+441234567890` |
| `BASE_URL` | Your public URL e.g. `https://abc123.ngrok.io` (no trailing slash) |
| `TRANSFER_NUMBER` | Your 3CX destination — see below |
| `DEFAULT_MESSAGE` | The message spoken to the recipient |
| `CALL_DELAY_MS` | Milliseconds between calls (default 2000) |

### 3. 3CX transfer destination

**Option A — SIP URI (recommended, free, no PSTN cost):**
```
sip:queue1@your3cx.yourdomain.com
```
In 3CX: go to your ring group or queue → SIP URI. Make sure your 3CX is publicly accessible or has a static IP.

**Option B — PSTN number:**
```
+441234567891
```
Uses your 3CX's DDI / direct number. Twilio will bill for this leg of the call.

### 4. Expose locally with ngrok (dev only)

```bash
npx ngrok http 3000
```

Copy the `https://....ngrok.io` URL into `BASE_URL` in your `.env`.

### 5. Start the server

```bash
npm start
```

Open **http://localhost:3000** in your browser.

---

## Usage

1. Open the dashboard at `http://localhost:3000`
2. Fill in your **message**, **3CX transfer destination**, and **Twilio caller ID**
3. Upload a CSV file — one phone number per row, e.g.:

```csv
phone
+441234567890
+447911123456
+442012345678
```

Numbers can be in any format — E.164 is preferred (`+44...`).

4. Click **Start campaign**
5. Watch live results — every call that presses 1 will appear as **Transferred ✓**

---

## How it works

```
CSV upload → placeCall() → Twilio dials number
                                    ↓
                          /twiml/answer  ← Twilio webhook
                          Plays message + Gather{numDigits:1}
                                    ↓
                    Recipient presses 1
                                    ↓
                          /twiml/keypress
                          <Dial> → 3CX SIP URI / number
                                    ↓
                          Call connected to agent
```

Answering machine detection (AMD) is enabled — voicemails are automatically skipped.

---

## CSV format

The CSV just needs phone numbers. These all work:

```csv
+441234567890
07911123456
+1-800-555-0100
```

Or with a header:
```csv
phone_number
+441234567890
+447911123456
```

---

## Production deployment

For production, deploy to a VPS (e.g. DigitalOcean, AWS EC2) instead of using ngrok:

```bash
# Install PM2
npm install -g pm2
pm2 start server.js --name press1-dialler
pm2 save
```

Set `BASE_URL` to your server's public domain with HTTPS (use Nginx + Certbot).

---

## Legal notice

Auto-diallers are regulated in the UK (ICO / PECR) and most other jurisdictions. Ensure you have:
- Consent or a legitimate interest basis for calling each number
- A suppression list for do-not-call requests
- Compliance with Ofcom and ICO guidelines

This software is provided as-is. You are responsible for legal compliance.
