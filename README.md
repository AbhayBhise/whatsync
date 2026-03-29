# ⚡ WHATSYNC BRIDGE
### *Slack ↔ WhatsApp. Bi-directional. Real-time. GDPR-compliant.*

> **Neobim Hackathon 2026** — Full Product Submission  
> Live at: `https://whatsync-production.up.railway.app`

---

## 🎯 What It Does

Whatsync Bridge connects your **Slack workspace** to **WhatsApp** — so your team never has to leave Slack to communicate with external contacts.

```
Slack User types /whatsapp1 918XXXXXXXXXX
        ↓
QR code generated in channel
        ↓
External user scans → taps Send
        ↓
Secure token verified → Consent granted
        ↓
Full bi-directional bridge: text + images, both ways
```

No third-party apps. No manual forwarding. No missed messages.

---

## ✅ Feature Checklist (Plan vs Built)

| Feature | Planned | Status |
|---|---|---|
| Two-way text messaging | ✅ | ✅ **Done** |
| Two-way image transfer | ✅ | ✅ **Done** |
| Image captions | ✅ | ✅ **Done** |
| Slack slash command `/whatsapp1` | ✅ | ✅ **Done** |
| QR code onboarding | ✅ | ✅ **Done** |
| WhatsApp opt-in confirmation | ✅ | ✅ **Done** |
| Token-based secure JOIN | ✅ | ✅ **Done** |
| 24hr token expiry | ✅ | ✅ **Done** |
| Thread persistence (restart-safe) | ✅ | ✅ **Done** |
| Message deduplication | ✅ | ✅ **Done** |
| GDPR explicit opt-in | ✅ | ✅ **Done** |
| GDPR right to erasure | ✅ | ✅ **Done** — immediate deletion |
| GDPR phone number hashing | ✅ | ✅ **Done** — sha256 |
| GDPR audit log | ✅ | ✅ **Done** — full event history |
| GDPR EU data residency | ✅ | ✅ **Done** — Amsterdam |
| `/whatsapp1 list` | ✅ | ✅ **Done** |
| `/whatsapp1 remove` | ✅ | ✅ **Done** |
| `/whatsapp1 ping` | ✅ | ✅ **Done** |
| `/whatsapp1 audit` | ✅ | ✅ **Done** |
| `/whatsapp1 setchannel` | ✅ | ✅ **Done** |
| Slack OAuth multi-workspace | ✅ | ✅ **Done** |
| Deployed on Railway (EU) | ✅ | ✅ **Done** |
| Sentry error monitoring | ✅ | ✅ **Done** |
| Auto CI/CD (Railway + GitHub) | ✅ | ✅ **Done** |
| Welcome message on join | ✅ | ✅ **Done** |
| Removal notification to WA user | ✅ | ✅ **Done** |
| Graceful 24hr session error feedback | ✅ | ✅ **Done** |
| Redis/BullMQ message queue | ✅ | 🔜 v2 — not needed at MVP scale |

---

## 🔐 Security & GDPR

### Phone Number Hashing
Phone numbers are **never stored in plaintext**. Every number is hashed with `sha256` before being written to the database:
```js
sha256("918459679367") → "0d8601a914154af6..."
```
The real number is only used for WhatsApp API delivery and never persisted.

### Secure Token Onboarding
No guessable JOINs. Every onboarding link is unique:
```
https://wa.me/15551855876?text=JOIN-1419028b3d0f641f22d3ed59dc68d33d
```
- Token tied to specific phone number
- 24-hour expiry
- Single use — deleted on match
- Mismatch = rejected

### Consent Enforcement
Zero messages pass without explicit consent:
```
No JOIN → No messages. Period.
```

### Right to Erasure
Three keywords trigger immediate full data deletion:
- `STOP`
- `UNSUBSCRIBE`  
- `STOPSLACK`

All records deleted instantly — Consent, Mapping, PendingConnection.

### Audit Log
Every event is logged permanently — even after data deletion:
```
JOINED        — whatsapp_user       — 30/3/2026 3:09am
PINGED        — slack_user:U0AP...  — 30/3/2026 3:10am
UNSUBSCRIBED  — whatsapp_user       — 30/3/2026 3:14am
JOINED        — whatsapp_user       — 30/3/2026 3:17am
REMOVED       — slack_user:U0AP...  — 30/3/2026 3:18am
```

---

## 🗄️ Database Models

| Model | Purpose |
|---|---|
| `Mapping` | phoneHash ↔ Slack threadTs ↔ teamId |
| `ProcessedMessage` | Deduplication by messageId |
| `PendingConnection` | Onboarding intent + token + TTL |
| `Consent` | Authorization gate — hashed phone |
| `WorkspaceInstall` | Multi-workspace OAuth tokens |
| `AuditLog` | GDPR tamper-proof event history |

---

## 🚀 Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 18 |
| HTTP Server | Express + Slack Bolt SDK |
| Database | PostgreSQL + Prisma ORM |
| Slack Integration | Slack Bolt (OAuth, Events, Commands) |
| WhatsApp Integration | Meta Cloud API v22.0 |
| Hosting | Railway (EU West — Amsterdam) |
| Error Monitoring | Sentry |
| CI/CD | GitHub → Railway auto-deploy |

---

## 📋 All Slash Commands

```
/whatsapp1 <number>         Onboard a new WhatsApp user (generates QR)
/whatsapp1 list             Show all connected users
/whatsapp1 remove <number>  Disconnect a user (GDPR deletion)
/whatsapp1 ping <number>    Nudge user to start conversation
/whatsapp1 audit <number>   View full GDPR audit history
/whatsapp1 setchannel       Set this channel as bridge channel
/whatsapp1 reply <message>  Reply to WhatsApp from thread
```

---

## 🔁 System Flow

```
┌─────────────────────────────────────────────────────┐
│                    ONBOARDING                        │
│                                                     │
│  Slack: /whatsapp1 918XXXXXXXXXX                    │
│         → token generated → QR posted in channel   │
│                                                     │
│  WA User: scans QR → sends JOIN-<token>             │
│         → token verified → consent stored (hashed) │
│         → welcome message sent to WA               │
│         → Slack notified: "user has joined"         │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              MESSAGING (BOTH DIRECTIONS)             │
│                                                     │
│  WA → Slack:                                        │
│    text/image → webhook → consent check →           │
│    thread created (or reused) → posted in Slack     │
│                                                     │
│  Slack → WA:                                        │
│    reply in thread → sendTo lookup →                │
│    Meta API → delivered to WA                       │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                   OPT-OUT                            │
│                                                     │
│  WA User sends: STOP / UNSUBSCRIBE / STOPSLACK      │
│    → all data deleted immediately                   │
│    → Slack notified                                 │
│    → audit log entry created                        │
└─────────────────────────────────────────────────────┘
```

---

## ⚙️ Setup & Run

### Prerequisites
- Node.js 18+
- PostgreSQL (Railway)
- Meta WhatsApp Business API account
- Slack workspace + app

### Environment Variables
```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_ID=C...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
WHATSAPP_TOKEN=EAA...
PHONE_NUMBER_ID=...
WHATSAPP_BUSINESS_NUMBER=15551855876
DATABASE_URL=postgresql://...
APP_URL=https://whatsync-production.up.railway.app
SENTRY_DSN=https://...
```

### Run Locally
```bash
npm install
npx prisma generate
npx prisma migrate dev
node index.js
```

### Deploy
Push to `main` branch → Railway auto-deploys. ✅

---

## 📍 Important Notes for Evaluators

### Meta Sandbox Restriction
The system uses a WhatsApp Business **sandbox number**. In sandbox mode:
- Outbound messages only reach manually allowlisted numbers
- Add test numbers at: Meta Developer Console → WhatsApp → API Setup → Allowed Recipients

In production: Template messages enable outbound to any number without pre-approval.

### Multi-Workspace Installation
1. Go to `https://whatsync-production.up.railway.app`
2. Click **"Add to Slack"**
3. Authorize for your workspace
4. Run `/whatsapp1 setchannel` in your desired channel
5. Start using `/whatsapp1 <number>`

### Private Channels
For private Slack channels, first run:
```
/invite @Whatsync Bridge
```
Public channels work automatically.

### 24-Hour Session Window
WhatsApp allows free-form replies only within 24 hours of the user's last message. If the window expires:
- Slack is notified automatically with instructions
- Use `/whatsapp1 ping <number>` to ask the user to re-initiate

---

## 📊 Architecture

```
GitHub (main branch)
    ↓ auto-deploy
Railway (EU West - Amsterdam)
    ├── whatsync (Node.js server)
    │   ├── Slack Bolt (commands + events)
    │   ├── Meta Webhook (WA messages)
    │   ├── Sentry (error monitoring)
    │   └── Prisma Client
    └── PostgreSQL (persistent state)
            ├── Mapping
            ├── Consent (hashed phones)
            ├── AuditLog
            ├── WorkspaceInstall
            ├── PendingConnection
            └── ProcessedMessage
```

---

## 🏆 What Makes This Stand Out

1. **Production-grade security** — sha256 phone hashing, token-based onboarding, consent enforcement
2. **Full GDPR compliance** — hashing, erasure, EU hosting, audit log that survives deletion
3. **Graceful error handling** — every failure notifies Slack with actionable instructions
4. **Zero plaintext PII** — phone numbers never stored in plaintext anywhere
5. **Tamper-proof audit trail** — full lifecycle logging per user
6. **True multi-workspace** — OAuth install, per-workspace tokens and channels
7. **Production deployment** — EU-hosted, auto CI/CD, Sentry monitoring

---

*Built for Neobim Hackathon 2026 — Team Whatsync*
