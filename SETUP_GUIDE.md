# WHATSYNC BRIDGE — Complete Setup Guide
## For Evaluators & New Workspace Installation

---

## PART 1 — PREREQUISITES

Before starting, you need accounts on:

| Service | URL | Purpose |
|---|---|---|
| Slack | slack.com | Workspace + app |
| Meta Developer | developers.facebook.com | WhatsApp API |
| Railway | railway.app | Hosting + DB |
| Sentry | sentry.io | Error monitoring |
| GitHub | github.com | Code repository |

---

## PART 2 — META WHATSAPP API SETUP

### Step 1 — Create Meta Developer App
1. Go to **developers.facebook.com**
2. Click **"My Apps"** → **"Create App"**
3. Select **"Business"** → click Next
4. Enter app name: `Whatsync Bridge`
5. Click **"Create App"**

### Step 2 — Add WhatsApp Product
1. In your app dashboard → scroll to **"Add Products"**
2. Find **"WhatsApp"** → click **"Set Up"**
3. Click **"Start using the API"**

### Step 3 — Get Credentials
Go to **WhatsApp → API Setup** and copy:
- **Phone Number ID** → save as `PHONE_NUMBER_ID`
- **WhatsApp Business Account ID** → save for reference
- Click **"Generate Token"** → save as `WHATSAPP_TOKEN`

### Step 4 — Add Test Numbers
Scroll to **"To"** field → add all phone numbers you want to test with.

> ⚠️ In sandbox mode only pre-approved numbers can receive messages.

### Step 5 — Configure Webhook
Go to **WhatsApp → Configuration → Webhook**:
- **Callback URL:** `https://whatsync-production.up.railway.app/webhook`
- **Verify Token:** `verify_token`
- Click **"Verify and Save"**

Scroll to **Webhook Fields** → subscribe to `messages`.

---

## PART 3 — SLACK APP SETUP

### Step 1 — Create Slack App
1. Go to **api.slack.com/apps**
2. Click **"Create New App"** → **"From Scratch"**
3. Name: `Whatsync Bridge`
4. Select your workspace → **"Create App"**

### Step 2 — Add Bot Token Scopes
Go to **OAuth & Permissions → Bot Token Scopes** → add:
```
channels:history
chat:write
commands
files:read
files:write
incoming-webhook
```

### Step 3 — Create Slash Command
Go to **Slash Commands** → **"Create New Command"**:
- **Command:** `/whatsapp1`
- **Request URL:** `https://whatsync-production.up.railway.app/slack/commands`
- **Description:** `WhatsApp bridge commands`
- Click **"Save"**

### Step 4 — Enable Events
Go to **Event Subscriptions**:
- Toggle **"Enable Events"** ON
- **Request URL:** `https://whatsync-production.up.railway.app/slack/events`
- Under **"Subscribe to bot events"** → add `message.channels`
- Click **"Save Changes"**

### Step 5 — OAuth Settings
Go to **OAuth & Permissions → Redirect URLs** → add:
```
https://whatsync-production.up.railway.app/slack/oauth_redirect
```
Click **"Save URLs"**

### Step 6 — Install App to Workspace
Go to **OAuth & Permissions** → click **"Install to Workspace"** → **"Allow"**

Copy the **Bot User OAuth Token** (starts with `xoxb-`) → save as `SLACK_BOT_TOKEN`

### Step 7 — Get Signing Secret
Go to **Basic Information → App Credentials** → copy:
- **Signing Secret** → save as `SLACK_SIGNING_SECRET`
- **Client ID** → save as `SLACK_CLIENT_ID`
- **Client Secret** → save as `SLACK_CLIENT_SECRET`

### Step 8 — Get Channel ID
In Slack, right-click your target channel → **"View channel details"** → scroll to bottom → copy Channel ID (starts with `C`) → save as `SLACK_CHANNEL_ID`

### Step 9 — Enable Public Distribution
Go to **Manage Distribution** → complete all checklist items → click **"Activate Public Distribution"**

---

## PART 4 — RAILWAY SETUP

### Step 1 — Create Project
1. Go to **railway.app** → **"New Project"**
2. Click **"Add PostgreSQL"** → database is created

### Step 2 — Deploy Server
1. Click **"New Service"** → **"GitHub Repo"**
2. Select `AbhayBhise/whatsync`
3. Railway auto-detects Node.js

### Step 3 — Add Environment Variables
Go to your whatsync service → **Variables** → add all:
```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_ID=C...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
WHATSAPP_TOKEN=EAA...
PHONE_NUMBER_ID=...
WHATSAPP_BUSINESS_NUMBER=15551855876
SENTRY_DSN=https://...
```

For `DATABASE_URL` → click **"Add Reference"** → select **Postgres → DATABASE_URL**

For `APP_URL` → add after generating domain (Step 5)

### Step 4 — Set EU Region
Go to **Settings → Scale → Regions** → select **"EU West (Amsterdam)"** → Deploy

Do the same for Postgres service.

### Step 5 — Generate Domain
Go to **Settings → Networking** → click **"Generate Domain"** → copy URL

Add to Variables:
```
APP_URL=https://your-app.up.railway.app
```

### Step 6 — Run Database Migration
Railway runs migrations automatically on deploy via Prisma.

If needed manually, connect to Railway shell and run:
```bash
npx prisma migrate deploy
```

---

## PART 5 — SENTRY SETUP

1. Go to **sentry.io** → create account
2. **"Create Project"** → select **"Node.js"** → **"Express"**
3. Copy the **DSN URL**
4. Add to Railway Variables: `SENTRY_DSN=https://...`

---

## PART 6 — FIRST TIME USE

### Install in a New Slack Workspace
1. Go to `https://whatsync-production.up.railway.app`
2. Click **"Add to Slack"**
3. Select your workspace → click **"Allow"**
4. You'll see **"✅ Whatsync installed!"**
5. Go to Slack → run `/whatsapp1 setchannel` in your desired channel

### Onboard a WhatsApp User
```
/whatsapp1 918XXXXXXXXXX
```
1. QR code appears in channel
2. Share QR with WhatsApp user
3. They scan → WhatsApp opens with JOIN-token pre-filled
4. They tap Send
5. Slack notified: **"✅ User has joined the bridge!"**
6. WhatsApp user receives welcome message

### Start Messaging
- **WA → Slack:** WhatsApp user sends any message → appears in Slack thread
- **Slack → WA:** Reply inside the Slack thread → delivered to WhatsApp
- **Images:** Supported both directions with optional captions

---

## PART 7 — ALL COMMANDS

```
/whatsapp1 <number>         Onboard new WhatsApp user (generates QR)
/whatsapp1 list             Show all connected users
/whatsapp1 remove <number>  Disconnect user (GDPR: all data deleted)
/whatsapp1 ping <number>    Send nudge to re-initiate conversation
/whatsapp1 audit <number>   View full GDPR audit history
/whatsapp1 setchannel       Set this channel as bridge channel
/whatsapp1 reply <message>  Reply to WhatsApp from slash command
```

---

## PART 8 — DEMO SCRIPT FOR EVALUATORS

Follow this sequence for a complete demo:

```
1. Open browser → https://whatsync-production.up.railway.app
   → Show "Add to Slack" landing page

2. In Slack → /whatsapp1 setchannel
   → Confirm channel is set

3. In Slack → /whatsapp1 918XXXXXXXXXX
   → Show QR code in channel

4. Scan QR on WhatsApp → tap Send
   → Show Slack notification: "user has joined"
   → Show welcome message on WhatsApp

5. Send text from WhatsApp
   → Show it appearing in Slack thread

6. Reply from Slack thread
   → Show it appearing on WhatsApp

7. Send image from WhatsApp with caption
   → Show it appearing in Slack thread

8. Send image from Slack thread with caption
   → Show it appearing on WhatsApp

9. In Slack → /whatsapp1 list
   → Show connected users

10. In Slack → /whatsapp1 ping 918XXXXXXXXXX
    → Show ping received on WhatsApp

11. In Slack → /whatsapp1 audit 918XXXXXXXXXX
    → Show full GDPR audit trail

12. Send UNSUBSCRIBE from WhatsApp
    → Show Slack notification: "user opted out"
    → Run audit again → show UNSUBSCRIBED event

13. In Slack → /whatsapp1 remove 918XXXXXXXXXX
    → Show removal notification in Slack
    → Show removal message on WhatsApp
```

---

## PART 9 — KNOWN LIMITATIONS (SANDBOX)

| Limitation | Reason | Production Fix |
|---|---|---|
| Only pre-approved numbers receive messages | Meta sandbox restriction | Verified Business Account |
| Cannot customize WhatsApp profile name | Sandbox test numbers | Meta Business Suite |
| Template messages not customizable | Requires Meta review | Submit templates for approval |
| Multi-workspace Slack review | Slack requires app review for marketplace | Submit to Slack Marketplace |

---

## PART 10 — TROUBLESHOOTING

| Issue | Cause | Fix |
|---|---|---|
| "Recipient not in allowed list" | Number not added in Meta sandbox | Add at Meta → API Setup → Allowed Recipients |
| "Message not delivered" after 24hrs | WhatsApp session expired | Use `/whatsapp1 ping` to re-initiate |
| Slash command not working | Bot not in channel | `/invite @Whatsync Bridge` |
| QR not appearing | Channel not set | Run `/whatsapp1 setchannel` first |
| Webhook not receiving | Wrong URL in Meta | Check Meta → Configuration → Callback URL |

---

## PART 11 — ARCHITECTURE DIAGRAM

```
┌──────────────────────────────────────────────────────────────┐
│                    WHATSYNC BRIDGE                            │
│                                                              │
│  ┌─────────────┐     ┌─────────────────┐    ┌────────────┐  │
│  │    SLACK    │────▶│  Railway Server  │───▶│ WhatsApp  │  │
│  │  Workspace  │◀────│  (Node.js + EU)  │◀───│   Users   │  │
│  └─────────────┘     └────────┬────────┘    └────────────┘  │
│                               │                              │
│                      ┌────────▼────────┐                    │
│                      │  PostgreSQL DB   │                    │
│                      │  (EU Amsterdam)  │                    │
│                      │                 │                     │
│                      │ • Mapping        │                    │
│                      │ • Consent(hash)  │                    │
│                      │ • AuditLog       │                    │
│                      │ • WorkspaceInstall│                   │
│                      │ • ProcessedMsg   │                    │
│                      └─────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
```

---

*Whatsync Bridge — Neobim Hackathon 2026*
