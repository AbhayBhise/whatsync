# ⚡ WHATSYNC BRIDGE
### *Connecting Teams. Bridging Conversations.*

> **Slack ↔ WhatsApp  •  Real-time  •  GDPR-Compliant  •  Enterprise-Ready**  
> **Neobim Hackathon 2026**

🌐 **Live:** https://whatsyncr.onrender.com  
➕ **Install:** [Add to Slack](https://whatsyncr.onrender.com)

---

## The Problem

Modern businesses run internal operations on Slack and external communications on WhatsApp — two worlds that don't talk to each other. Teams resort to manual forwarding, screenshot sharing, and constant context-switching.

**Whatsync Bridge eliminates this gap entirely.**

---

## What It Does

```
External contact messages on WhatsApp
              ↓
Appears instantly in your Slack thread
              ↓
Your team replies in Slack
              ↓
Delivered to WhatsApp in real time
```

No third-party apps. No manual forwarding. No missed messages.

---

## Three Messaging Modes

| Mode | Trigger | Result |
|---|---|---|
| **1:1 Private** | Reply inside a Slack thread | Only that WhatsApp user receives it |
| **Broadcast** | Type in the main Slack channel | ALL connected WhatsApp users receive it |
| **@all from WA** | WhatsApp user sends `@all message` | Posted in Slack channel — visible to everyone |

---

## Feature Highlights

| Category | Features |
|---|---|
| **Messaging** | Text + images both directions, captions, broadcast, @all |
| **Onboarding** | Secure QR + link, cryptographic token, 24hr expiry |
| **GDPR** | Explicit opt-in, right to erasure, EU hosting, audit log |
| **Security** | Phone hashing, masked logs, consent enforcement, rate limiting |
| **Commands** | list, remove, ping, audit, setchannel, reply |
| **Multi-workspace** | OAuth install, per-workspace isolation, workspace switching |
| **Monitoring** | Error tracking, uptime monitoring, auto CI/CD |

---

## Security at a Glance

🔐 **Zero plaintext PII** — phone numbers are cryptographically hashed before any storage  
🔐 **Token onboarding** — unique, time-limited, single-use, phone-bound tokens  
🔐 **Consent gate** — no message passes without verified explicit opt-in  
🔐 **Right to erasure** — STOP / UNSUBSCRIBE / STOPSLACK triggers instant full deletion  
🔐 **Masked logs** — phone numbers never appear in server logs  
🔐 **EU residency** — server in Frankfurt, database in Amsterdam  

---

## GDPR Compliance

| Requirement | Status |
|---|---|
| Explicit opt-in | ✅ Cryptographic token flow |
| Right to erasure | ✅ Immediate, complete, irreversible |
| Data minimisation | ✅ Zero message content stored |
| Pseudonymisation | ✅ sha256 — unrecoverable |
| EU data residency | ✅ Frankfurt + Amsterdam |
| Audit trail | ✅ Survives data deletion |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18 |
| Slack | Slack Bolt SDK (OAuth, Events, Commands) |
| WhatsApp | Meta Cloud API |
| Database | PostgreSQL + Prisma ORM |
| Server | Render — EU Frankfurt |
| DB Host | Railway — EU Amsterdam |
| Monitoring | Sentry + UptimeRobot |
| CI/CD | GitHub → Render (auto-deploy) |

---

## All Slash Commands

```
/whatsapp1 <number>         Onboard a new WhatsApp user
/whatsapp1 list             View all connected users
/whatsapp1 remove <number>  Disconnect + GDPR full erasure
/whatsapp1 ping <number>    Re-initiate expired session
/whatsapp1 audit <number>   View full GDPR event history
/whatsapp1 setchannel       Set bridge channel for this workspace
/whatsapp1 reply <message>  Reply via slash command
```

---

## Architecture

```
┌─────────────────┐      ┌──────────────────────┐      ┌──────────────┐
│   Slack Teams   │◀────▶│   Whatsync Bridge    │◀────▶│  WA Users   │
│  (N workspaces) │      │   Render EU Central  │      │  (verified) │
└─────────────────┘      │                      │      └──────────────┘
                         │  ┌────────────────┐  │
                         │  │  PostgreSQL DB  │  │
                         │  │  EU Amsterdam   │  │
                         │  └────────────────┘  │
                         └──────────────────────┘
```

---

## Scale Design

Each workspace operates in complete isolation with its own bot token, channel binding, and user list. In production, each workspace receives a dedicated WhatsApp Business number — the same model used by Intercom, Clerk Chat, and Zendesk.

| Scale | Workspaces | Est. Cost | Est. Revenue |
|---|---|---|---|
| Early | 1,000 | ~$0 | $1,000+/month |
| Growth | 100,000 | ~$4,000/month | $100,000+/month |
| Scale | 1,000,000 | ~$40,000/month | $1,000,000+/month |

---

## What Makes This Stand Out

1. **Production-grade from day one** — not a prototype, live on EU infrastructure
2. **Three messaging modes** — private threads + broadcast + @all bidirectional
3. **Enterprise security** — zero plaintext PII, cryptographic onboarding, consent enforcement
4. **Full GDPR compliance** — right to erasure, EU hosting, tamper-proof audit log
5. **True multi-workspace** — any Slack workspace installs with one click
6. **Designed for scale** — architecture supports millions of workspaces

---

> *Built for Neobim Hackathon 2026 — Team Whatsync A*  
> 🌐 https://whatsyncr.onrender.com
