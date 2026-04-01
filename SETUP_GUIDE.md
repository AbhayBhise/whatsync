# WHATSYNC BRIDGE — Evaluator Guide
### How to Install, Test, and Evaluate

> 🌐 Live at: **https://whatsyncr.onrender.com**

---

## Quick Start (2 minutes)

1. Go to **https://whatsyncr.onrender.com**
2. Click **"Add to Slack"** → select your workspace → Allow
3. In Slack → go to any channel → run `/whatsapp1 setchannel`
4. Run `/whatsapp1 <your-number>` to onboard yourself as a WhatsApp user
5. Scan the QR on WhatsApp → tap Send → you're connected

---

## Complete Demo Sequence

Follow this sequence to evaluate every capability of the system:

### Phase 1 — Onboarding
| Step | Action | Expected |
|---|---|---|
| 1 | Open https://whatsyncr.onrender.com | Add to Slack landing page |
| 2 | Click Add to Slack → authorize | Workspace installed |
| 3 | `/whatsapp1 setchannel` | Channel confirmed as bridge |
| 4 | `/whatsapp1 918XXXXXXXXXX` | QR code + link appears |
| 5 | Scan QR on WhatsApp → tap Send | Joined notification in Slack + welcome on WA |

### Phase 2 — 1:1 Messaging
| Step | Action | Expected |
|---|---|---|
| 6 | Send text from WhatsApp | Appears in Slack thread |
| 7 | Reply from Slack thread | Delivered to WhatsApp |
| 8 | Send image with caption from WhatsApp | Image + caption in Slack thread |
| 9 | Send image with caption from Slack thread | Image + caption on WhatsApp |

### Phase 3 — Broadcast
| Step | Action | Expected |
|---|---|---|
| 10 | Type message in main Slack channel (not thread) | ALL connected WA users receive it with sender name |
| 11 | Send `@all hello team` from WhatsApp | Appears in Slack main channel + user's thread |
| 12 | Reply to @all message in Slack thread | WhatsApp user receives the reply |
| 13 | Send image with `@all` caption from WhatsApp | Image broadcast to Slack channel |

### Phase 4 — Commands & GDPR
| Step | Action | Expected |
|---|---|---|
| 14 | `/whatsapp1 list` | Connected users shown (hashed — no PII) |
| 15 | `/whatsapp1 ping 918XXXXXXXXXX` | WA user receives nudge |
| 16 | `/whatsapp1 audit 918XXXXXXXXXX` | Full GDPR event history |
| 17 | Send `UNSUBSCRIBE` from WhatsApp | Slack notified, all data deleted instantly |
| 18 | `/whatsapp1 audit` after unsub | UNSUBSCRIBED event logged — audit survives deletion |
| 19 | `/whatsapp1 remove 918XXXXXXXXXX` | WA notified, admin-initiated removal |

---

## Important Notes

### Meta Sandbox
The system uses a WhatsApp sandbox number. To receive messages during demo, your number must be added to the allowed recipients list at:
> Meta Developer Console → WhatsApp → API Setup → Allowed Recipients

### Private Channels
For private Slack channels, first run:
```
/invite @Whatsync Bridge
```
Public channels work automatically.

### 24-Hour Session Window
WhatsApp allows free-form replies only within 24 hours of the user's last message. If the window expires, use `/whatsapp1 ping <number>` to re-initiate.

### Multi-Workspace
Install Whatsync Bridge in multiple workspaces by visiting https://whatsyncr.onrender.com from each workspace. Each workspace operates completely independently.

---

## What to Look For

When evaluating, pay attention to:

- **Security** — run `/whatsapp1 list` and notice numbers are shown as hashes, never plaintext
- **Audit trail** — run `/whatsapp1 audit` and see every event in a user's lifecycle
- **Right to erasure** — after UNSUBSCRIBE, run audit again — log survives but data is gone
- **Broadcast** — type in the channel (not a thread) and watch all WA users receive it
- **@all** — the reverse broadcast from WhatsApp back to the Slack channel
- **Multi-workspace** — install in two workspaces and verify complete isolation

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Slash command shows "operation timeout" | Wait 30 seconds and retry — Render may be warming up |
| "Recipient not in allowed list" | Add number to Meta sandbox allowlist |
| Message not delivered after 24hrs | Use `/whatsapp1 ping` to re-initiate session |
| Bot not responding in private channel | Run `/invite @Whatsync Bridge` first |
| QR not appearing | Run `/whatsapp1 setchannel` in the channel first |

---

> *Whatsync Bridge — Neobim Hackathon 2026*  
> 🌐 https://whatsyncr.onrender.com
