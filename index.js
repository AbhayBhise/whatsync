require("./instrument.js");
const Sentry = require("@sentry/node");
const dns = require("dns");
const crypto = require("crypto");
dns.setDefaultResultOrder("ipv4first");
const FormData = require("form-data");
const https = require("https");
require("https").globalAgent.options.family = 4;

const express = require("express");
const axios = require("axios");
require("dotenv").config();

const { App, ExpressReceiver } = require("@slack/bolt");

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const QRCode = require("qrcode");

// ===============================
// 🔹 PHONE HASHING (GDPR)
// ===============================
function hashPhone(phoneNumber) {
    return crypto.createHash("sha256").update(phoneNumber.toString().trim()).digest("hex");
}

function maskPhone(phoneNumber) {
    const str = phoneNumber.toString();
    return str.substring(0, 4) + "****" + str.substring(str.length - 2);
}


// ===============================
// 🔹 AUDIT LOGGING (GDPR)
// ===============================
async function auditLog(phoneHash, action, initiatedBy, teamId) {
    try {
        await prisma.auditLog.create({
            data: { phoneHash, action, initiatedBy, teamId }
        });
    } catch (err) {
        console.error("❌ Audit log failed:", err.message);
    }
}

// Auto-clean expired PendingConnections every 30 seconds
setInterval(async () => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        const deleted = await prisma.pendingConnection.deleteMany({
            where: { expiresAt: { lt: new Date() } }
        });
        if (deleted.count > 0) {
            console.log(`🧹 Cleaned ${deleted.count} expired pending connections`);
        }
    } catch (err) {
        try { await prisma.$disconnect(); } catch { }
        try { await prisma.$connect(); } catch { }
    }
}, 30 * 1000);

// ===============================
// 🔹 SLACK BOLT SETUP
// ===============================
const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    endpoints: {
        commands: "/slack/commands",
        events: "/slack/events"
    }
});

const slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver
});
receiver.app.set("trust proxy", 1);
receiver.app.use(express.json());
receiver.app.use(express.urlencoded({ extended: true }));

const rateLimit = require("express-rate-limit");
receiver.app.use("/webhook", rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests, please try again later."
}));
receiver.app.use((req, res, next) => {
    console.log("👉 Incoming request:", req.method, req.url);
    next();
});
// Ignore Slack retry attempts to prevent duplicate broadcasts
receiver.app.use((req, res, next) => {
    if (req.headers["x-slack-retry-num"]) {
        console.log("⚠️ Slack retry ignored:", req.headers["x-slack-retry-num"]);
        return res.sendStatus(200);
    }
    next();
});
if (!process.env.WHATSAPP_TOKEN || !process.env.PHONE_NUMBER_ID) {
    console.error("Missing environment variables");
    process.exit(1);
}



// ===============================
// 🔹 SLACK COMMANDS (BOLT)
// ===============================

slackApp.command("/whatsapp1", async ({ command, ack, respond }) => {
    await ack(); // MUST be first

    console.log("🔥 Slash command received:", command.text);

    const parts = command.text.trim().split(/\s+/);
    const subcommand = parts[0];

    // ===============================
    // DEFAULT: /whatsapp1 <number>
    // ===============================
    if (/^\d{10,15}$/.test(subcommand)) {
        const number = subcommand;
        const teamId = command.team_id;

        // Check if number already connected
        // Check if number already connected IN THIS WORKSPACE
        const existingConsent = await prisma.consent.findFirst({
            where: { phoneNumber: hashPhone(number), teamId }
        });

        if (existingConsent && existingConsent.consentGiven) {
            return respond({
                response_type: "ephemeral",
                text: `⚠️ *${number} is already connected.*\nThey are an active bridge user. Use \`/whatsapp1 ping ${number}\` to reach them or \`/whatsapp1 remove ${number}\` to disconnect them first.`
            });
        }
        const token = crypto.randomBytes(16).toString("hex");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        try {
            await prisma.pendingConnection.create({
                data: { phoneNumber: hashPhone(number), token, teamId, expiresAt }
            });
        } catch (err) {
            console.log("⚠️ DB insert failed:", err.message);
        }

        const BUSINESS_NUMBER = process.env.WHATSAPP_BUSINESS_NUMBER;
        const waLink = `https://wa.me/${BUSINESS_NUMBER}?text=JOIN-${token}`;

        // Generate QR code as PNG buffer
        const qrBuffer = await QRCode.toBuffer(waLink, { width: 300, margin: 2 });

        // Upload QR to Slack
        // Upload QR to Slack using workspace token
        const { WebClient } = require("@slack/web-api");
        const wsInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
        const wsToken = wsInstall?.botToken || process.env.SLACK_BOT_TOKEN;
        const slackClient = new WebClient(wsToken);

        // Save channel if not set yet
        if (wsInstall && !wsInstall.channelId) {
            await prisma.workspaceInstall.update({
                where: { teamId },
                data: { channelId: command.channel_id }
            });
        }

        try {
            await slackClient.files.uploadV2({
                channel_id: command.channel_id,
                file: qrBuffer,
                filename: `connect-${number}.png`,
                initial_comment: `📲 *Onboarding QR for ${number}*\n\nShare this QR code with the user. They scan it → WhatsApp opens → tap Send.\n\n⏳ Expires in 24 hours.\n🔗 Direct link: ${waLink}`
            });

            await respond({
                response_type: "ephemeral",
                text: `✅ QR code posted in channel for ${number}.`
            });
        } catch (err) {
            if (err.data?.error === "not_in_channel") {
                await respond({
                    response_type: "ephemeral",
                    text: `⚠️ *Whatsync Bridge is not in this channel.*\n\nPlease run this first:\n\`/invite @Whatsync Bridge\`\n\nThen try again.`
                });
            } else {
                await respond({
                    response_type: "ephemeral",
                    text: `❌ Error: ${err.message}`
                });
            }
        }
        return;
    }
    // ===============================
    // LIST: /whatsapp1 list
    // ===============================
    if (subcommand === "list") {
        const teamId = command.team_id;

        const consented = await prisma.consent.findMany({
            where: { teamId, consentGiven: true }
        });

        if (consented.length === 0) {
            return respond({
                response_type: "ephemeral",
                text: "📋 No WhatsApp users currently connected."
            });
        }

        const lines = await Promise.all(consented.map(async (c) => {
            const mapping = await prisma.mapping.findFirst({
                where: { phoneNumber: c.phoneNumber, teamId }
            });
            const since = c.createdAt.toDateString();
            return `• *${c.phoneNumber.substring(0, 8)}...* (hashed) — connected since ${since}${mapping ? ` — thread: ${mapping.threadTs}` : ""}`;
        }));

        return respond({
            response_type: "ephemeral",
            text: `📋 *Connected WhatsApp users (${consented.length}):*\n${lines.join("\n")}`
        });
    }

    // ===============================
    // INVITE: /whatsapp1 invite <number>
    // ===============================
    if (subcommand === "invite") {
        const number = parts[1];

        if (!number || !/^\d{10,15}$/.test(number)) {
            return respond("Usage: /whatsapp1 invite 91XXXXXXXXXX");
        }

        const BUSINESS_NUMBER = process.env.WHATSAPP_BUSINESS_NUMBER;

        const waLink = `https://wa.me/${BUSINESS_NUMBER}?text=JOIN`;

        await respond({
            response_type: "ephemeral",
            text: `To connect ${subcommand}, ask them to click:\n${waLink}`
        });
        return;
    }
    // ===============================
    // REMOVE: /whatsapp1 remove <number>
    // ===============================
    if (subcommand === "remove") {
        const number = parts[1];

        if (!number || !/^\d{10,15}$/.test(number)) {
            return respond("Usage: /whatsapp1 remove 91XXXXXXXXXX");
        }

        const teamId = command.team_id;

        const consent = await prisma.consent.findFirst({
            where: { phoneNumber: hashPhone(number), teamId }
        });

        if (!consent) {
            return respond({
                response_type: "ephemeral",
                text: `⚠️ ${number} is not connected to this workspace.`
            });
        }
        // Notify WhatsApp user before deleting data
        try {
            await axios.post(
                `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
                {
                    messaging_product: "whatsapp",
                    to: number,
                    type: "text",
                    text: {
                        body: `⚠️ You have been removed from the Slack bridge by a team member.\n\nYou will no longer receive or be able to send messages through this channel.\n\nIf you'd like to reconnect, ask the team to invite you again.`
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                        "Content-Type": "application/json"
                    }
                }
            );
        } catch (err) {
            console.error("❌ Remove notification to WA failed:", err.message);
        }

        await auditLog(hashPhone(number), "REMOVED_BY_SLACK", `slack_user:${command.user_id}`, teamId);

        // GDPR: delete all data
        await prisma.consent.delete({ where: { phoneNumber: hashPhone(number) } });
        await prisma.mapping.deleteMany({ where: { phoneNumber: hashPhone(number) } });
        await prisma.pendingConnection.deleteMany({ where: { phoneNumber: hashPhone(number) } });
        // Notify in channel
        const workspaceInstall = await prisma.workspaceInstall.findUnique({
            where: { teamId }
        });
        const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;
        const SLACK_CHANNEL = workspaceInstall?.channelId || process.env.SLACK_CHANNEL_ID;
        const { WebClient } = require("@slack/web-api");
        const slackClient = new WebClient(botToken);

        await slackClient.chat.postMessage({
            channel: SLACK_CHANNEL,
            text: `🔴 *${number} has been removed* from the bridge by a Slack user. All their data has been deleted.`
        });

        return respond({
            response_type: "ephemeral",
            text: `✅ ${number} has been disconnected and all data deleted.`
        });
    }

    // ===============================
    // SETCHANNEL: /whatsapp1 setchannel
    // ===============================
    if (subcommand === "setchannel") {
        const teamId = command.team_id;
        const channelId = command.channel_id;
        const botToken = command.token;

        try {
            await prisma.workspaceInstall.upsert({
                where: { teamId },
                update: { channelId },
                create: {
                    teamId,
                    botToken: process.env.SLACK_BOT_TOKEN,
                    channelId
                }
            });

            return respond({
                response_type: "ephemeral",
                text: `✅ This channel has been set as the default bridge channel for your workspace.\n\nAll WhatsApp messages will now appear here.`
            });
        } catch (err) {
            console.error("❌ setchannel error:", err.message);
            return respond({
                response_type: "ephemeral",
                text: `❌ Failed to set channel: ${err.message}`
            });
        }
    }

    // ===============================
    // AUDIT: /whatsapp1 audit <number>
    // ===============================
    if (subcommand === "audit") {
        const number = parts[1];

        if (!number || !/^\d{10,15}$/.test(number)) {
            return respond("Usage: /whatsapp1 audit 91XXXXXXXXXX");
        }

        const teamId = command.team_id;
        const logs = await prisma.auditLog.findMany({
            where: { phoneHash: hashPhone(number), teamId },
            orderBy: { createdAt: "asc" }
        });

        if (logs.length === 0) {
            return respond({
                response_type: "ephemeral",
                text: `📋 No audit history found for ${number}.`
            });
        }

        const lines = logs.map(l => {
            const time = new Date(l.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
            return `• \`${l.action}\` — by *${l.initiatedBy}* at ${time}`;
        });

        return respond({
            response_type: "ephemeral",
            text: `📋 *Audit log for ${number} (${logs.length} events):*\n${lines.join("\n")}`
        });
    }
    // ===============================
    // OPEN: /whatsapp1 open <number>
    // ===============================
    if (subcommand === "open") {
        const number = parts[1];

        if (!number || !/^\d{10,15}$/.test(number)) {
            return respond("Usage: /whatsapp1 open 91XXXXXXXXXX");
        }

        const teamId = command.team_id;
        const mapping = await prisma.mapping.findFirst({
            where: { phoneNumber: hashPhone(number), teamId }
        });

        if (!mapping) {
            return respond({
                response_type: "ephemeral",
                text: `⚠️ No thread found for ${number}. They may not have joined yet.`
            });
        }

        const workspaceInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
        const channelId = workspaceInstall?.channelId || process.env.SLACK_CHANNEL_ID;

        return respond({
            response_type: "ephemeral",
            text: `🧵 Jump to ${number}'s thread:\nhttps://slack.com/app_redirect?channel=${channelId}&message_ts=${mapping.threadTs}`
        });
    }
    // ===============================
    // PING: /whatsapp1 ping <number>
    // ===============================
    if (subcommand === "ping") {
        const number = parts[1];

        if (!number || !/^\d{10,15}$/.test(number)) {
            return respond("Usage: /whatsapp1 ping 91XXXXXXXXXX");
        }

        // Check consent exists
        const consent = await prisma.consent.findFirst({
            where: { phoneNumber: hashPhone(number), teamId: command.team_id }
        });

        if (!consent) {
            return respond({
                response_type: "ephemeral",
                text: `⚠️ ${number} is not connected. Use /whatsapp1 ${number} to onboard them first.`
            });
        }

        // Send ping message to WhatsApp
        try {
            await axios.post(
                `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
                {
                    messaging_product: "whatsapp",
                    to: number,
                    type: "text",
                    text: {
                        body: `👋 The team on Slack wants to chat with you!\n\nPlease reply to this message to start the conversation. The session lasts 24 hours from your last message.`
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                        "Content-Type": "application/json"
                    }
                }
            );

            await auditLog(hashPhone(number), "PINGED", `slack_user:${command.user_id}`, command.team_id);

            return respond({
                response_type: "ephemeral",
                text: `✅ Ping sent to ${number}. They'll be notified to start the conversation.`
            });
        } catch (err) {
            const code = err.response?.data?.error?.code;
            let errMsg = `❌ Could not ping ${number}.`;
            if (code === 131030) {
                errMsg += ` Number not in Meta sandbox allowlist.`;
            } else if (code === 131047) {
                errMsg += ` WhatsApp 24-hour session expired — user must message first.`;
            } else {
                errMsg += ` Error: ${err.response?.data?.error?.message || err.message}`;
            }
            return respond({
                response_type: "ephemeral",
                text: errMsg
            });
        }
    }

    // ===============================
    // REPLY: /whatsapp1 reply <message>
    // ===============================
    if (subcommand === "reply") {
        const message = parts.slice(1).join(" ");

        if (!message) {
            return respond("Usage: /whatsapp1 reply <message>");
        }

        const threadTs = command.thread_ts || command.ts;

        console.log("🧵 Reply in thread:", threadTs);

        const mapping = await prisma.mapping.findFirst({
            where: { threadTs: threadTs.toString() }
        });

        if (!mapping || !mapping.phoneNumber) {
            return respond("❌ This thread is not linked to any WhatsApp user");
        }

        const number = mapping.sendTo || mapping.phoneNumber;

        await respond(`📤 Sending to ${number}...`);

        await sendWhatsAppMessage(number, message);

        return;
    }

    // ===============================
    // FALLBACK
    // ===============================
    return respond(
        "Unknown command. Available commands:\n" +
        "• `/whatsapp1 <number>` — onboard a new WhatsApp user\n" +
        "• `/whatsapp1 list` — show all connected users\n" +
        "• `/whatsapp1 remove <number>` — disconnect a user\n" +
        "• `/whatsapp1 ping <number>` — nudge a WhatsApp user to start conversation\n" +
        "• `/whatsapp1 audit <number>` — view full audit history for a number\n" +
        "• `/whatsapp1 open <number>` — jump to that user's thread\n" +
        "• `/whatsapp1 setchannel` — set this channel as the bridge channel for your workspace"
    );
});

// ===============================
// 🔹 SLACK FILE SHARE HANDLER
// ===============================
slackApp.event("message", async ({ event, context }) => {
    console.log("📨 Event received:", event.subtype, "thread:", event.thread_ts, "team:", event.team);
    if (event.subtype !== "file_share") return;
    if (event.bot_id) return;

    // ===============================
    // BROADCAST: main channel image → all WA users
    // ===============================
    if (!event.thread_ts) {
        const teamId = event.team || event.user_team || context.teamId;
        if (!teamId) {
            console.log("❌ No teamId in file_share event");
            return;
        }
        console.log("📢 Broadcasting image, teamId:", teamId);

        const consented = await prisma.consent.findMany({
            where: { teamId, consentGiven: true }
        });
        if (consented.length === 0) return;

        const workspaceInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
        const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;
        const { WebClient: BCast } = require("@slack/web-api");
        const broadcastSlack = new BCast(botToken);

        let senderName = "Team";
        try {
            const userInfo = await broadcastSlack.users.info({ user: event.user });
            senderName = userInfo.user?.real_name || userInfo.user?.name || "Team";
        } catch (err) { }

        for (const file of (event.files || [])) {
            if (!file.mimetype?.startsWith("image/")) continue;
            try {
                const imageRes = await axios.get(file.url_private, {
                    responseType: "arraybuffer",
                    headers: { Authorization: `Bearer ${botToken}` },
                    httpsAgent: new https.Agent({ family: 4 })
                });

                const form = new FormData();
                form.append("file", Buffer.from(imageRes.data), {
                    filename: file.name || "image.jpg",
                    contentType: file.mimetype
                });
                form.append("type", file.mimetype);
                form.append("messaging_product", "whatsapp");

                const uploadRes = await axios.post(
                    `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/media`,
                    form,
                    { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
                );

                const mediaId = uploadRes.data.id;
                const caption = event.text ? `📢 ${senderName}: ${event.text}` : `📢 ${senderName} sent an image`;

                for (const consent of consented) {
                    await new Promise(r => setTimeout(r, 50));
                    const mapping = await prisma.mapping.findFirst({
                        where: { phoneNumber: consent.phoneNumber, teamId }
                    });
                    if (mapping?.sendTo) {
                        await axios.post(
                            `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
                            {
                                messaging_product: "whatsapp",
                                to: mapping.sendTo,
                                type: "image",
                                image: { id: mediaId, caption }
                            },
                            { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
                        );
                        console.log("✅ Image broadcast to:", maskPhone(mapping.sendTo));
                    }
                }
            } catch (err) {
                console.error("❌ Image broadcast error:", err.response?.data || err.message);
            }
        }
        return;
    }

    console.log("📎 File share event received:", JSON.stringify({
        files: event.files?.map(f => ({ name: f.name, mimetype: f.mimetype })),
        thread_ts: event.thread_ts,
        team: event.team
    }));

    const threadTs = event.thread_ts.toString();
    const mapping = await prisma.mapping.findFirst({
        where: { threadTs }
    });

    if (!mapping) {
        console.log("❌ No mapping for this thread");
        return;
    }

    const teamId = mapping.teamId;
    const number = mapping.sendTo || mapping.phoneNumber;

    for (const file of (event.files || [])) {
        if (!file.mimetype?.startsWith("image/")) {
            console.log("⚠️ Non-image file ignored:", file.mimetype);
            continue;
        }

        try {
            const wsInstallForDownload = await prisma.workspaceInstall.findUnique({
                where: { teamId }
            });
            const botToken = wsInstallForDownload?.botToken || process.env.SLACK_BOT_TOKEN;

            // Step 1: Download from Slack (axios follows redirects; Slack url_private redirects to CDN)

            const imageRes = await axios.get(file.url_private, {
                responseType: "arraybuffer",
                headers: { Authorization: `Bearer ${botToken}` },
                httpsAgent: new https.Agent({ family: 4 })
            });

            // Step 2: Upload to Meta
            // const FormData = require("form-data");
            const form = new FormData();
            form.append("file", Buffer.from(imageRes.data), {
                filename: file.name || "image.jpg",
                contentType: file.mimetype
            });
            form.append("type", file.mimetype);
            form.append("messaging_product", "whatsapp");

            const uploadRes = await axios.post(
                `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/media`,
                form,
                {
                    headers: {
                        ...form.getHeaders(),
                        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
                    }
                }
            );

            const mediaId = uploadRes.data.id;

            // Step 3: Send image to WhatsApp
            const caption = (event.text && event.text !== file.name && event.text !== file.title)
                ? event.text : "";

            try {
                await axios.post(
                    `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
                    {
                        messaging_product: "whatsapp",
                        to: number,
                        type: "image",
                        image: { id: mediaId, caption }
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                            "Content-Type": "application/json"
                        }
                    }
                );
                console.log("✅ Image sent Slack→WhatsApp:", maskPhone(number));
            } catch (imgErr) {
                const errData = imgErr.response?.data?.error;
                const code = errData?.code;
                const errMsg = errData?.message || imgErr.message;
                console.error("❌ Image send failed:", JSON.stringify(errData));

                const { WebClient: WC } = require("@slack/web-api");
                const notifyClient = new WC(process.env.SLACK_BOT_TOKEN);
                let userMsg = `❌ Image not delivered to ${number}. Error: ${errMsg}`;
                if (code === 131047 || errMsg?.includes("24")) {
                    userMsg = `⏰ Image not delivered to ${number}. WhatsApp 24-hour session expired. Ask user to send a message first.`;
                } else if (code === 131030 || errMsg?.includes("not allowed")) {
                    userMsg = `🚫 Image not delivered to ${number}. Number not in Meta sandbox allowlist.`;
                }
                try {
                    await notifyClient.chat.postMessage({
                        channel: process.env.SLACK_CHANNEL_ID,
                        thread_ts: event.thread_ts,
                        text: userMsg
                    });
                } catch (e) { }
            }

        } catch (err) {
            console.error("❌ Slack→WA image error:", err.response?.data || err.message);
        }
    }
});
// ===============================
// 🔹 SLACK MESSAGE LISTENER (THREAD REPLIES)
// ===============================
slackApp.message(async ({ message }) => {
    if (message.subtype || message.bot_id) return;

    // ===============================
    // BROADCAST: main channel → all WA users
    // ===============================
    if (!message.thread_ts) {
        if (message.bot_profile || message.bot_id) return;
        if (!message.user) return;
        const teamId = message.team;
        if (!teamId) return;

        const consented = await prisma.consent.findMany({
            where: { teamId, consentGiven: true }
        });

        if (consented.length === 0) return;

        const workspaceInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
        const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;
        const { WebClient: BroadcastClient } = require("@slack/web-api");
        const broadcastSlack = new BroadcastClient(botToken);

        let senderName = "Team";
        try {
            const userInfo = await broadcastSlack.users.info({ user: message.user });
            senderName = userInfo.user?.real_name || userInfo.user?.name || "Team";
        } catch (err) { }

        // Handle image broadcast
        if (message.files && message.files.length > 0) {
            for (const file of message.files) {
                if (!file.mimetype?.startsWith("image/")) continue;
                try {

                    const imageRes = await axios.get(file.url_private, {
                        responseType: "arraybuffer",
                        headers: { Authorization: `Bearer ${botToken}` },
                        httpsAgent: new https.Agent({ family: 4 })
                    });

                    // const FormData = require("form-data");
                    const form = new FormData();
                    form.append("file", Buffer.from(imageRes.data), {
                        filename: file.name || "image.jpg",
                        contentType: file.mimetype
                    });
                    form.append("type", file.mimetype);
                    form.append("messaging_product", "whatsapp");

                    const uploadRes = await axios.post(
                        `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/media`,
                        form,
                        { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
                    );

                    const mediaId = uploadRes.data.id;
                    const caption = message.text ? `📢 ${senderName}: ${message.text}` : `📢 ${senderName} sent an image`;

                    for (const consent of consented) {
                        await new Promise(r => setTimeout(r, 50));
                        const mapping = await prisma.mapping.findFirst({
                            where: { phoneNumber: consent.phoneNumber, teamId }
                        });
                        if (mapping?.sendTo) {
                            await axios.post(
                                `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
                                {
                                    messaging_product: "whatsapp",
                                    to: mapping.sendTo,
                                    type: "image",
                                    image: { id: mediaId, caption }
                                },
                                { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
                            );
                        }
                    }
                    console.log("✅ Image broadcast Slack→all WA users");
                } catch (err) {
                    console.error("❌ Image broadcast error:", JSON.stringify(err.response?.data) || err.message);
                    console.error("❌ Image broadcast stack:", err.message);
                }
            }
            return;
        }

        // Text broadcast
        if (!message.text) return;
        const broadcastText = `📢 *${senderName}:* ${message.text}`;

        for (const consent of consented) {
            await new Promise(r => setTimeout(r, 50));
            const mapping = await prisma.mapping.findFirst({
                where: { phoneNumber: consent.phoneNumber, teamId }
            });
            if (mapping?.sendTo) {
                await sendWhatsAppMessage(mapping.sendTo, broadcastText);
            }
        }
        return;
    }

    // existing thread logic continues below unchanged...


    const threadTs = message.thread_ts.toString();
    const teamId = message.team;

    const mapping = await prisma.mapping.findFirst({
        where: { threadTs, teamId }
    });

    if (!mapping) {
        console.log("❌ No mapping for this thread");
        return;
    }

    const number = mapping.sendTo || mapping.phoneNumber;

    // ===============================
    // Handle image/file attachments
    // ===============================
    if (message.files && message.files.length > 0) {
        for (const file of message.files) {
            // Only handle images
            if (!file.mimetype?.startsWith("image/")) {
                console.log("⚠️ Non-image file ignored:", file.mimetype);
                continue;
            }

            try {
                const workspaceInstall = await prisma.workspaceInstall.findUnique({
                    where: { teamId }
                });
                const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;

                // Step 1: Download image from Slack (axios follows redirects to CDN)

                const imageRes = await axios.get(file.url_private, {
                    responseType: "arraybuffer",
                    headers: { Authorization: `Bearer ${botToken}` },
                    httpsAgent: new https.Agent({ family: 4 })
                });

                // Step 2: Upload to Meta media endpoint
                // const FormData = require("form-data");
                const form = new FormData();
                form.append("file", Buffer.from(imageRes.data), {
                    filename: file.name || "image.jpg",
                    contentType: file.mimetype
                });
                form.append("type", file.mimetype);
                form.append("messaging_product", "whatsapp");

                const uploadRes = await axios.post(
                    `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/media`,
                    form,
                    {
                        headers: {
                            ...form.getHeaders(),
                            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
                        }
                    }
                );

                const mediaId = uploadRes.data.id;

                // Step 3: Send image via WhatsApp
                await axios.post(
                    `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
                    {
                        messaging_product: "whatsapp",
                        to: number,
                        type: "image",
                        image: {
                            id: mediaId,
                            caption: (message.text && message.text !== file.name && message.text !== file.title) ? message.text : ""
                        }
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                            "Content-Type": "application/json"
                        }
                    }
                );

                console.log("✅ Image sent from Slack → WhatsApp:", (maskPhone(number)));
            } catch (err) {
                console.error("❌ Image Slack→WA error:", err.response?.data || err.message);
            }
        }
        return; // done with files
    }

    // ===============================
    // Handle plain text (existing)
    // ===============================
    const userMessage = message.text;
    if (!userMessage) return;

    console.log("📤 Sending text to WhatsApp:", number);
    const workspaceInstallForSend = await prisma.workspaceInstall.findFirst({
        where: { teamId }
    });
    const botTokenForSend = workspaceInstallForSend?.botToken || process.env.SLACK_BOT_TOKEN;
    const channelForSend = workspaceInstallForSend?.channelId || process.env.SLACK_CHANNEL_ID;
    const { WebClient: WebClientSend } = require("@slack/web-api");
    const slackClientForSend = new WebClientSend(botTokenForSend);
    await sendWhatsAppMessage(number, userMessage, slackClientForSend, threadTs, channelForSend);
});

// ===============================
// 🔹 SEND WHATSAPP MESSAGE
// ===============================
async function sendWhatsAppMessage(to, message, slackClient = null, threadTs = null, channelId = null) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.PHONE_NUMBER_ID;

    try {
        const response = await axios.post(
            `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
            {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: message }
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json"
                }
            }
        );
        console.log("✅ WhatsApp sent:", response.data);
    } catch (error) {
        const errData = error.response?.data?.error;
        const code = errData?.code;
        const errMsg = errData?.message || error.message;

        console.error("❌ WhatsApp Error:", JSON.stringify(errData, null, 2));

        // Notify Slack thread about the failure
        if (slackClient && threadTs && channelId) {
            let userMessage = `⚠️ Failed to deliver message to WhatsApp (${to}).`;

            if (code === 131047 || errMsg?.includes("24")) {
                userMessage = `⏰ *Message not delivered to ${to}.*\nWhatsApp only allows replies within 24 hours of the user's last message. Ask them to send a message first to reopen the session.`;
            } else if (code === 131030 || errMsg?.includes("not allowed")) {
                userMessage = `🚫 *Message not delivered to ${to}.*\nThis number is not in the Meta sandbox allowlist. Add it at: Meta Developer Console → WhatsApp → API Setup → Allowed Recipients.`;
            } else if (code === 131026) {
                userMessage = `🚫 *Message not delivered to ${to}.*\nNumber does not exist on WhatsApp or is invalid.`;
            } else {
                userMessage = `❌ *Message not delivered to ${to}.*\nError: ${errMsg}`;
            }

            try {
                await slackClient.chat.postMessage({
                    channel: channelId,
                    thread_ts: threadTs,
                    text: userMessage
                });
            } catch (slackErr) {
                console.error("❌ Could not notify Slack:", slackErr.message);
            }
        }
    }
}



// ===============================
// 🔹 START SERVER (SINGLE PORT)
// ===============================
(async () => {
    await receiver.app.listen(3000);
    console.log("⚡ Slack Bolt running on port 3000");

    const expressApp = receiver.app;


    // Attach ONLY your routes (not whole app)
    expressApp.get("/", (req, res) => {
        const clientId = process.env.SLACK_CLIENT_ID;
        const appUrl = process.env.APP_URL;
        const oauthUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=channels:history,chat:write,commands,files:read,files:write,channels:read,incoming-webhook&redirect_uri=${appUrl}/slack/oauth_redirect`;
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="slack-app-id" content="A0AP7C4Q7MF">
<title>Whatsync Bridge — Slack ↔ WhatsApp</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#fff;overflow-x:hidden}
.orb{position:fixed;border-radius:50%;filter:blur(90px);opacity:0.12;animation:float 9s ease-in-out infinite;pointer-events:none;z-index:0}
.orb1{width:600px;height:600px;background:#4A154B;top:-150px;left:-150px;animation-delay:0s}
.orb2{width:500px;height:500px;background:#25D366;top:30%;right:-150px;animation-delay:3s}
.orb3{width:400px;height:400px;background:#1565C0;bottom:0;left:15%;animation-delay:6s}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-25px)}}
.grid{position:fixed;inset:0;background-image:linear-gradient(rgba(255,255,255,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.025) 1px,transparent 1px);background-size:60px 60px;pointer-events:none;z-index:0}
canvas{position:fixed;inset:0;pointer-events:none;z-index:1}
.wrap{position:relative;z-index:10;max-width:1000px;margin:0 auto;padding:60px 24px}
.badge{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:100px;padding:6px 18px;font-size:13px;color:rgba(255,255,255,0.6);margin-bottom:28px;animation:up 0.7s ease both}
.live-dot{width:7px;height:7px;border-radius:50%;background:#25D366;animation:blink 1.5s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
h1{font-size:clamp(38px,6vw,68px);font-weight:800;line-height:1.1;text-align:center;margin-bottom:20px;animation:up 0.7s 0.1s ease both}
.gt{background:linear-gradient(135deg,#8B2FC9,#4A154B 40%,#25D366);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.sub{font-size:17px;color:rgba(255,255,255,0.45);text-align:center;max-width:480px;margin:0 auto 36px;line-height:1.65;animation:up 0.7s 0.2s ease both}
.slack-btn-wrap{display:flex;justify-content:center;margin-bottom:14px;animation:up 0.7s 0.3s ease both}
.slack-btn-wrap a{display:inline-block;transition:transform 0.2s,filter 0.2s}
.slack-btn-wrap a:hover{transform:translateY(-3px);filter:brightness(1.1)}
.slack-btn-wrap img{height:52px;width:auto}
.hint{text-align:center;font-size:12px;color:rgba(255,255,255,0.2);margin-bottom:52px;animation:up 0.7s 0.4s ease both}
.flow{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:60px;animation:up 0.7s 0.5s ease both;flex-wrap:wrap}
.ftag{display:flex;align-items:center;gap:7px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:100px;padding:8px 18px;font-size:13px;color:rgba(255,255,255,0.65)}
.fd{width:8px;height:8px;border-radius:50%}
.arr{color:rgba(255,255,255,0.2);font-size:20px}
.sec-label{text-align:center;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.22);margin-bottom:22px}
.demos{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-bottom:60px}
.demo-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:16px;overflow:hidden;animation:up 0.7s ease both}
.demo-card:nth-child(1){animation-delay:0.6s}.demo-card:nth-child(2){animation-delay:0.75s}.demo-card:nth-child(3){animation-delay:0.9s}
.demo-screen{aspect-ratio:16/9;background:#111318;border-bottom:1px solid rgba(255,255,255,0.06);padding:10px;overflow:hidden}
.slack-bar{display:flex;align-items:center;gap:5px;margin-bottom:8px}
.sbd{width:5px;height:5px;border-radius:50%}
.chan{font-size:7px;color:rgba(255,255,255,0.25);margin-left:4px}
.mr{display:flex;align-items:flex-start;gap:5px;margin-bottom:5px}
.av{width:16px;height:16px;border-radius:4px;flex-shrink:0;margin-top:1px}
.mb{background:rgba(255,255,255,0.05);border-radius:5px;padding:3px 6px;font-size:7.5px;color:rgba(255,255,255,0.65);line-height:1.4;max-width:88%}
.mb.cmd{background:rgba(74,21,75,0.35);color:#d4a0f0;font-family:monospace}
.mb.ok{background:rgba(37,211,102,0.12);color:#80f0a8}
.mb.nfo{background:rgba(21,101,192,0.2);color:#90c8f8}
.ibar{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.04);border-radius:5px;padding:4px 7px;margin-top:5px}
.itext{font-size:6.5px;color:rgba(255,255,255,0.35);font-family:monospace;flex:1}
.sbtn{width:11px;height:11px;background:#4A154B;border-radius:3px;flex-shrink:0}
.demo-info{padding:12px 14px}
.demo-cmd{font-size:10.5px;font-family:monospace;color:#c98de8;margin-bottom:4px}
.demo-desc{font-size:10.5px;color:rgba(255,255,255,0.38);line-height:1.55}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin-bottom:52px}
.feat{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:13px;padding:16px;animation:up 0.7s ease both}
.feat:nth-child(1){animation-delay:1.0s}.feat:nth-child(2){animation-delay:1.1s}.feat:nth-child(3){animation-delay:1.2s}
.feat:nth-child(4){animation-delay:1.3s}.feat:nth-child(5){animation-delay:1.4s}.feat:nth-child(6){animation-delay:1.5s}
.feat-ico{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;margin-bottom:9px}
.feat h3{font-size:12.5px;font-weight:600;margin-bottom:4px}
.feat p{font-size:11px;color:rgba(255,255,255,0.32);line-height:1.5}
.footer{text-align:center;padding-top:32px;border-top:1px solid rgba(255,255,255,0.06)}
.footer-top{font-size:12px;color:rgba(255,255,255,0.18);margin-bottom:10px}
.team{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-bottom:14px}
.team-member{font-size:11px;color:rgba(255,255,255,0.28);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:100px;padding:4px 12px}
.footer-link{color:rgba(255,255,255,0.22);font-size:11px;text-decoration:none}
.footer-link:hover{color:rgba(255,255,255,0.4)}
@keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:640px){.demos,.features{grid-template-columns:1fr}.flow{gap:6px}}
</style>
</head>
<body>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="orb orb3"></div>
<div class="grid"></div>
<canvas id="c"></canvas>
<div class="wrap">
  <div style="text-align:center">
    <div class="badge"><span class="live-dot"></span>Live &middot; EU Hosted &middot; GDPR Compliant</div>
  </div>
  <h1>Connect <span class="gt">Slack</span> to<br><span class="gt">WhatsApp</span></h1>
  <p class="sub">Real-time bi-directional messaging bridge for your team. Text, images, broadcasts &mdash; one click install.</p>
  <div class="slack-btn-wrap">
    <a href="${oauthUrl}">
      <img alt="Add to Slack" height="52" src="https://platform.slack-edge.com/img/add_to_slack@2x.png" />
    </a>
  </div>
  <p class="hint">Free &middot; No credit card &middot; Works with any Slack workspace</p>
  <div class="flow">
    <div class="ftag"><span class="fd" style="background:#4A154B"></span>Slack workspace</div>
    <span class="arr">&#8644;</span>
    <div class="ftag"><span class="fd" style="background:#1565C0"></span>Whatsync Bridge</div>
    <span class="arr">&#8644;</span>
    <div class="ftag"><span class="fd" style="background:#25D366"></span>WhatsApp users</div>
  </div>
  <p class="sec-label">See it in action</p>
  <div class="demos">
    <div class="demo-card">
      <div class="demo-screen">
        <div class="slack-bar"><div class="sbd" style="background:#ff5f57"></div><div class="sbd" style="background:#febc2e"></div><div class="sbd" style="background:#28c840"></div><span class="chan">#bridge-channel</span></div>
        <div class="mr"><div class="av" style="background:#4A154B"></div><div class="mb cmd">/whatsapp1 918XXXXXXXXXX</div></div>
        <div class="mr"><div class="av" style="background:#1565C0"></div><div><div class="mb ok">&#128247; QR code posted in channel</div><div class="mb ok" style="margin-top:3px">&#128279; Direct link ready &middot; 24hr expiry</div></div></div>
        <div class="mr"><div class="av" style="background:#25D366"></div><div class="mb nfo">&#9989; 918XX has joined the bridge!</div></div>
        <div class="ibar"><div class="itext">/whatsapp1 918XXXXXXXXXX</div><div class="sbtn"></div></div>
      </div>
      <div class="demo-info"><div class="demo-cmd">/whatsapp1 &lt;number&gt;</div><div class="demo-desc">Generates a secure QR + link. User scans &rarr; joins in seconds with full consent flow.</div></div>
    </div>
    <div class="demo-card">
      <div class="demo-screen">
        <div class="slack-bar"><div class="sbd" style="background:#ff5f57"></div><div class="sbd" style="background:#febc2e"></div><div class="sbd" style="background:#28c840"></div><span class="chan">#bridge-channel</span></div>
        <div class="mr"><div class="av" style="background:#25D366"></div><div class="mb nfo">&#128241; 918XX: Hey! Got your message</div></div>
        <div class="mr"><div class="av" style="background:#25D366"></div><div class="mb nfo">&#128206; 918XX sent an image</div></div>
        <div class="mr"><div class="av" style="background:#4A154B"></div><div class="mb cmd">Thanks! Sending the doc now</div></div>
        <div class="mr"><div class="av" style="background:#1565C0"></div><div class="mb ok">&#9989; Delivered to WhatsApp</div></div>
        <div class="ibar"><div class="itext">Reply in thread &rarr; goes to WhatsApp</div><div class="sbtn"></div></div>
      </div>
      <div class="demo-info"><div class="demo-cmd">Thread reply</div><div class="demo-desc">Reply in any Slack thread &mdash; delivered directly to that WhatsApp user instantly.</div></div>
    </div>
    <div class="demo-card">
      <div class="demo-screen">
        <div class="slack-bar"><div class="sbd" style="background:#ff5f57"></div><div class="sbd" style="background:#febc2e"></div><div class="sbd" style="background:#28c840"></div><span class="chan">#bridge-channel</span></div>
        <div class="mr"><div class="av" style="background:#4A154B"></div><div class="mb cmd">Team meeting at 5pm today!</div></div>
        <div class="mr"><div class="av" style="background:#1565C0"></div><div><div class="mb ok">&#128226; Broadcast sent to 3 WA users</div><div class="mb ok" style="margin-top:3px">&rarr; 918XX &#10003; &rarr; 919XX &#10003; &rarr; 917XX &#10003;</div></div></div>
        <div class="mr"><div class="av" style="background:#25D366"></div><div class="mb nfo">&#128226; @all: Running 10 min late!</div></div>
        <div class="ibar"><div class="itext">Channel message &rarr; all WA users</div><div class="sbtn"></div></div>
      </div>
      <div class="demo-info"><div class="demo-cmd">Broadcast mode</div><div class="demo-desc">Channel messages reach all WA users. WA users send @all back to the channel.</div></div>
    </div>
  </div>
  <p class="sec-label">Everything included</p>
  <div class="features">
    <div class="feat"><div class="feat-ico" style="background:rgba(74,21,75,0.2)">&#128172;</div><h3>Bi-directional</h3><p>Text + images both directions in real time</p></div>
    <div class="feat"><div class="feat-ico" style="background:rgba(37,211,102,0.12)">&#128226;</div><h3>Broadcast</h3><p>Channel &rarr; all WA users &middot; @all WA &rarr; channel</p></div>
    <div class="feat"><div class="feat-ico" style="background:rgba(21,101,192,0.2)">&#128274;</div><h3>GDPR Compliant</h3><p>sha256 hashing &middot; EU hosting &middot; audit log</p></div>
    <div class="feat"><div class="feat-ico" style="background:rgba(255,193,7,0.12)">&#9889;</div><h3>Multi-workspace</h3><p>One-click OAuth install for any workspace</p></div>
    <div class="feat"><div class="feat-ico" style="background:rgba(233,30,99,0.12)">&#128737;</div><h3>Consent gate</h3><p>Explicit opt-in &middot; STOP/UNSUBSCRIBE anytime</p></div>
    <div class="feat"><div class="feat-ico" style="background:rgba(156,39,176,0.15)">&#128203;</div><h3>Audit trail</h3><p>Full GDPR event history per user</p></div>
  </div>
  <div class="footer">
    <p class="footer-top">Neobim Hackathon 2026 &middot; Team WhatSync A</p>
    <div class="team">
      <span class="team-member">Abhay Bhise</span>
      <span class="team-member">Sneha Paliwal</span>
      <span class="team-member">Namrata Paralkar</span>
      <span class="team-member">Shivraj Chatap</span>
    </div>
    <a href="https://github.com/AbhayBhise/whatsync" class="footer-link">github.com/AbhayBhise/whatsync</a>
  </div>
</div>
<script>
const c=document.getElementById('c');
const x=c.getContext('2d');
c.width=window.innerWidth;c.height=window.innerHeight;
const pts=Array.from({length:70},()=>({x:Math.random()*c.width,y:Math.random()*c.height,r:Math.random()*1.2+0.3,dx:(Math.random()-.5)*.25,dy:(Math.random()-.5)*.25,o:Math.random()*.18+.03}));
(function loop(){x.clearRect(0,0,c.width,c.height);pts.forEach(p=>{p.x+=p.dx;p.y+=p.dy;if(p.x<0||p.x>c.width)p.dx*=-1;if(p.y<0||p.y>c.height)p.dy*=-1;x.beginPath();x.arc(p.x,p.y,p.r,0,Math.PI*2);x.fillStyle='rgba(255,255,255,'+p.o+')';x.fill();});requestAnimationFrame(loop);})();
window.addEventListener('resize',()=>{c.width=window.innerWidth;c.height=window.innerHeight});
</script>
</body>
</html>`);
    });

    expressApp.get("/slack/oauth_redirect", async (req, res) => {
        try {
            const code = req.query.code;
            if (!code) return res.status(400).send("Missing code");

            const response = await axios.post("https://slack.com/api/oauth.v2.access", null, {
                params: {
                    client_id: process.env.SLACK_CLIENT_ID,
                    client_secret: process.env.SLACK_CLIENT_SECRET,
                    code,
                    redirect_uri: `${process.env.APP_URL}/slack/oauth_redirect`
                }
            });

            const data = response.data;
            if (!data.ok) {
                console.error("OAuth error:", data.error);
                return res.status(400).send("OAuth failed: " + data.error);
            }

            await prisma.workspaceInstall.upsert({
                where: { teamId: data.team.id },
                update: {
                    botToken: data.access_token,
                    teamName: data.team.name
                },
                create: {
                    teamId: data.team.id,
                    botToken: data.access_token,
                    teamName: data.team.name,
                    channelId: null
                }
            });

            console.log("✅ OAuth install complete for:", data.team.name);
            // Send instructions to install channel

            console.log("✅ OAuth install complete for:", data.team.name);
            res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Whatsync Bridge — Successfully Installed!</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#fff;overflow-x:hidden}
.orb{position:fixed;border-radius:50%;filter:blur(90px);opacity:0.1;animation:float 9s ease-in-out infinite;pointer-events:none;z-index:0}
.orb1{width:500px;height:500px;background:#4A154B;top:-100px;left:-100px}
.orb2{width:400px;height:400px;background:#25D366;bottom:0;right:-100px;animation-delay:4s}
.grid{position:fixed;inset:0;background-image:linear-gradient(rgba(255,255,255,0.02) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.02) 1px,transparent 1px);background-size:60px 60px;pointer-events:none}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-20px)}}
.wrap{position:relative;z-index:10;max-width:900px;margin:0 auto;padding:50px 24px}

/* SUCCESS BANNER */
.success-banner{text-align:center;margin-bottom:48px;animation:up 0.6s ease both}
.check-circle{width:72px;height:72px;border-radius:50%;background:rgba(37,211,102,0.15);border:2px solid rgba(37,211,102,0.3);display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 20px;animation:pop 0.5s cubic-bezier(0.175,0.885,0.32,1.275) both}
@keyframes pop{from{transform:scale(0)}to{transform:scale(1)}}
.success-banner h1{font-size:clamp(28px,5vw,48px);font-weight:800;margin-bottom:12px}
.gt{background:linear-gradient(135deg,#8B2FC9,#25D366);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.success-banner p{font-size:16px;color:rgba(255,255,255,0.45);max-width:460px;margin:0 auto 28px;line-height:1.6}
.next-step{display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px 24px;font-size:14px;color:rgba(255,255,255,0.7)}
.step-num{width:24px;height:24px;border-radius:50%;background:#4A154B;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.cmd-pill{background:rgba(74,21,75,0.4);border:1px solid rgba(139,47,201,0.3);border-radius:6px;padding:2px 8px;font-family:monospace;font-size:13px;color:#c98de8}

/* SECTION */
.sec-label{text-align:center;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.2);margin:48px 0 20px}

/* INDUSTRY NEED */
.problem-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:48px}
.problem-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:18px;animation:up 0.6s ease both}
.problem-card:nth-child(1){animation-delay:0.1s}.problem-card:nth-child(2){animation-delay:0.2s}
.problem-card:nth-child(3){animation-delay:0.3s}.problem-card:nth-child(4){animation-delay:0.4s}
.tag{display:inline-block;font-size:10px;padding:3px 10px;border-radius:100px;margin-bottom:10px;font-weight:600}
.tag.bad{background:rgba(220,50,50,0.15);color:#f87171;border:1px solid rgba(220,50,50,0.2)}
.tag.good{background:rgba(37,211,102,0.12);color:#6ef4a0;border:1px solid rgba(37,211,102,0.2)}
.problem-card h3{font-size:13px;font-weight:600;margin-bottom:6px}
.problem-card p{font-size:11.5px;color:rgba(255,255,255,0.38);line-height:1.55}

/* COMMANDS */
.commands{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:48px}
.cmd-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:13px;padding:16px;display:flex;gap:12px;align-items:flex-start;animation:up 0.6s ease both}
.cmd-card:nth-child(1){animation-delay:0.1s}.cmd-card:nth-child(2){animation-delay:0.2s}
.cmd-card:nth-child(3){animation-delay:0.3s}.cmd-card:nth-child(4){animation-delay:0.4s}
.cmd-card:nth-child(5){animation-delay:0.5s}.cmd-card:nth-child(6){animation-delay:0.6s}
.cmd-card:nth-child(7){animation-delay:0.7s}
.cmd-ico{width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0}
.cmd-card h3{font-size:11.5px;font-family:monospace;color:#c98de8;margin-bottom:4px}
.cmd-card p{font-size:11px;color:rgba(255,255,255,0.35);line-height:1.5}

/* BENEFITS */
.benefits{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:48px}
.benefit{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:13px;padding:16px;text-align:center;animation:up 0.6s ease both}
.benefit:nth-child(1){animation-delay:0.1s}.benefit:nth-child(2){animation-delay:0.2s}.benefit:nth-child(3){animation-delay:0.3s}
.benefit:nth-child(4){animation-delay:0.4s}.benefit:nth-child(5){animation-delay:0.5s}.benefit:nth-child(6){animation-delay:0.6s}
.benefit-ico{font-size:24px;margin-bottom:10px}
.benefit h3{font-size:12.5px;font-weight:600;margin-bottom:5px}
.benefit p{font-size:11px;color:rgba(255,255,255,0.32);line-height:1.5}

/* STATS */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:48px}
.stat{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:13px;padding:16px;text-align:center;animation:up 0.6s ease both}
.stat-num{font-size:28px;font-weight:800;margin-bottom:4px}
.stat-label{font-size:11px;color:rgba(255,255,255,0.35)}

/* FOOTER */
.footer{text-align:center;padding-top:28px;border-top:1px solid rgba(255,255,255,0.06)}
.footer p{font-size:12px;color:rgba(255,255,255,0.2);margin-bottom:8px}
.team{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin-bottom:12px}
.tm{font-size:11px;color:rgba(255,255,255,0.28);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:100px;padding:4px 12px}
.footer a{color:rgba(255,255,255,0.22);font-size:11px;text-decoration:none}

@keyframes up{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:640px){.problem-grid,.commands,.benefits,.stats{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="grid"></div>

<div class="wrap">

  <!-- SUCCESS -->
  <div class="success-banner">
    <div class="check-circle">✅</div>
    <h1>Whatsync Bridge<br><span class="gt">Successfully Installed!</span></h1>
    <p>Your Slack workspace is now connected to the Whatsync Bridge. You're one command away from bridging your team with WhatsApp.</p>
    <div class="next-step">
      <div class="step-num">1</div>
      Go to Slack &rarr; your channel &rarr; type &nbsp;<span class="cmd-pill">/whatsapp1 setchannel</span>&nbsp; then &nbsp;<span class="cmd-pill">/whatsapp1 918XXXXXXXXXX</span>
    </div>
  </div>

  <!-- INDUSTRY NEED -->
  <p class="sec-label">Why this exists</p>
  <div class="problem-grid">
    <div class="problem-card">
      <div class="tag bad">Before Whatsync</div>
      <h3>Manual forwarding nightmare</h3>
      <p>Teams copy-paste WhatsApp messages into Slack manually. Context gets lost. Messages get missed. Hours wasted every week.</p>
    </div>
    <div class="problem-card">
      <div class="tag good">After Whatsync</div>
      <h3>Zero-effort real-time bridge</h3>
      <p>Every WhatsApp message appears instantly in Slack. Replies go back automatically. Zero manual work. Zero missed messages.</p>
    </div>
    <div class="problem-card">
      <div class="tag bad">Before Whatsync</div>
      <h3>Announcements sent one by one</h3>
      <p>Sending updates to 20 WhatsApp contacts means 20 individual messages. Time-consuming, error-prone, impossible to scale.</p>
    </div>
    <div class="problem-card">
      <div class="tag good">After Whatsync</div>
      <h3>Broadcast to everyone instantly</h3>
      <p>Type once in your Slack channel &mdash; every connected WhatsApp user receives it in seconds. One message, unlimited reach.</p>
    </div>
  </div>

  <!-- COMMANDS -->
  <p class="sec-label">All commands at your fingertips</p>
  <div class="commands">
    <div class="cmd-card">
      <div class="cmd-ico" style="background:rgba(74,21,75,0.2)">&#128247;</div>
      <div>
        <h3>/whatsapp1 &lt;number&gt;</h3>
        <p>Onboard a new WhatsApp contact. Generates a secure QR code + link with 24hr expiry. They scan &rarr; bridge is live.</p>
      </div>
    </div>
    <div class="cmd-card">
      <div class="cmd-ico" style="background:rgba(37,211,102,0.12)">&#128203;</div>
      <div>
        <h3>/whatsapp1 list</h3>
        <p>View all connected WhatsApp users in your workspace. Phone numbers shown as privacy-safe hashes &mdash; zero PII exposed.</p>
      </div>
    </div>
    <div class="cmd-card">
      <div class="cmd-ico" style="background:rgba(233,30,99,0.12)">&#128680;</div>
      <div>
        <h3>/whatsapp1 remove &lt;number&gt;</h3>
        <p>Disconnect a user. Notifies them on WhatsApp, deletes all their data immediately. Full GDPR right to erasure.</p>
      </div>
    </div>
    <div class="cmd-card">
      <div class="cmd-ico" style="background:rgba(255,193,7,0.12)">&#128276;</div>
      <div>
        <h3>/whatsapp1 ping &lt;number&gt;</h3>
        <p>Re-initiate an expired WhatsApp session. Sends a nudge to the user asking them to message first and reopen the 24hr window.</p>
      </div>
    </div>
    <div class="cmd-card">
      <div class="cmd-ico" style="background:rgba(21,101,192,0.2)">&#128196;</div>
      <div>
        <h3>/whatsapp1 audit &lt;number&gt;</h3>
        <p>View the full GDPR event history for any number &mdash; joins, pings, messages, opt-outs, removals. Tamper-proof log.</p>
      </div>
    </div>
    <div class="cmd-card">
      <div class="cmd-ico" style="background:rgba(156,39,176,0.15)">&#128279;</div>
      <div>
        <h3>/whatsapp1 open &lt;number&gt;</h3>
        <p>Jump directly to any user's Slack thread. No scrolling, no searching &mdash; instant navigation to the right conversation.</p>
      </div>
    </div>
    <div class="cmd-card">
      <div class="cmd-ico" style="background:rgba(37,211,102,0.12)">&#128226;</div>
      <div>
        <h3>Channel broadcast</h3>
        <p>Type any message in your Slack channel (not in a thread) &mdash; ALL connected WhatsApp users receive it instantly with your name.</p>
      </div>
    </div>
  </div>

  <!-- STATS -->
  <p class="sec-label">Built for scale</p>
  <div class="stats">
    <div class="stat">
      <div class="stat-num" style="color:#c98de8">&#8734;</div>
      <div class="stat-label">WhatsApp users<br>per workspace</div>
    </div>
    <div class="stat">
      <div class="stat-num" style="color:#6ef4a0">&lt;1s</div>
      <div class="stat-label">Message delivery<br>latency</div>
    </div>
    <div class="stat">
      <div class="stat-num" style="color:#90c8f8">100%</div>
      <div class="stat-label">GDPR<br>compliant</div>
    </div>
    <div class="stat">
      <div class="stat-num" style="color:#fbbf24">EU</div>
      <div class="stat-label">Data residency<br>Frankfurt + Amsterdam</div>
    </div>
  </div>

  <!-- BENEFITS -->
  <p class="sec-label">Why teams love it</p>
  <div class="benefits">
    <div class="benefit">
      <div class="benefit-ico">&#9889;</div>
      <h3>Zero context switching</h3>
      <p>Your team stays in Slack. WhatsApp contacts stay in WhatsApp. Everyone works where they're comfortable.</p>
    </div>
    <div class="benefit">
      <div class="benefit-ico">&#128274;</div>
      <h3>Enterprise security</h3>
      <p>Phone numbers hashed with sha256. Explicit consent required. Full audit trail. EU data residency.</p>
    </div>
    <div class="benefit">
      <div class="benefit-ico">&#128226;</div>
      <h3>One-to-many broadcast</h3>
      <p>Announce to all WhatsApp contacts with one Slack message. Scale your outreach instantly.</p>
    </div>
    <div class="benefit">
      <div class="benefit-ico">&#128200;</div>
      <h3>Full conversation history</h3>
      <p>Every message archived in Slack threads. Searchable. Organized. Never lose a conversation.</p>
    </div>
    <div class="benefit">
      <div class="benefit-ico">&#128101;</div>
      <h3>Multi-workspace ready</h3>
      <p>Each department or team gets their own isolated workspace with their own contacts and channels.</p>
    </div>
    <div class="benefit">
      <div class="benefit-ico">&#128640;</div>
      <h3>Production deployed</h3>
      <p>Live on EU infrastructure. Auto CI/CD. Sentry monitoring. UptimeRobot. Built to stay online.</p>
    </div>
  </div>

  <div class="footer">
    <p>Whatsync Bridge &middot; Neobim Hackathon 2026 &middot; Team WhatSync A</p>
    <div class="team">
      <span class="tm">Abhay Bhise</span>
      <span class="tm">Sneha Paliwal</span>
      <span class="tm">Namrata Paralkar</span>
      <span class="tm">Shivraj Chatap</span>
    </div>
    <a href="https://github.com/AbhayBhise/whatsync">github.com/AbhayBhise/whatsync</a>
  </div>

</div>
</body>
</html>`);
        } catch (err) {
            console.error("OAuth redirect error:", err.message);
            res.status(500).send("Installation failed");
        }
    });



    // WhatsApp webhook verify

    expressApp.get("/webhook", (req, res) => {
        const verify_token = process.env.WEBHOOK_VERIFY_TOKEN || "verify_token";

        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];

        if (mode === "subscribe" && token === verify_token) {
            console.log("Webhook verified");
            return res.status(200).send(challenge);
        } else {
            return res.sendStatus(403);
        }
    });

    // WhatsApp webhook receive
    expressApp.post("/webhook", async (req, res) => {
        try {
            const entry = req.body.entry?.[0];
            const changes = entry?.changes?.[0];
            const message = changes?.value?.messages?.[0];

            // 1. Ensure message exists
            if (!message) return res.sendStatus(200);

            // 2. Handle image messages
            if (message.type === "image") {
                const imageId = message.image?.id;
                const caption = message.image?.caption || "";
                const messageId = message.id;
                const from = message.from?.toString().trim();

                if (!imageId) return res.sendStatus(200);

                // Dedup
                const exists = await prisma.processedMessage.findUnique({ where: { messageId } });
                if (exists) return res.sendStatus(200);
                await prisma.processedMessage.create({ data: { messageId } });

                // Consent check
                const consent = await prisma.consent.findUnique({ where: { phoneNumber: hashPhone(from) } });
                console.log("🔍 Consent lookup for:", (maskPhone(from)), "→ result:", consent);
                if (!consent || !consent.consentGiven) {
                    console.log("🚫 Blocked image (no consent):", maskPhone(from));
                    return res.sendStatus(200);
                }

                // Get workspace token
                const consentRecord = consent;
                const teamId = consentRecord?.teamId || "default_workspace";
                const workspaceInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
                const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;
                const SLACK_CHANNEL = workspaceInstall?.channelId || process.env.SLACK_CHANNEL_ID;
                const { WebClient } = require("@slack/web-api");
                const slackClient = new WebClient(botToken);

                try {
                    // Step 1: Get image URL from Meta
                    const mediaRes = await axios.get(
                        `https://graph.facebook.com/v22.0/${imageId}`,
                        { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
                    );
                    const imageUrl = mediaRes.data.url;

                    // Step 2: Download image binary
                    const imageBuffer = await axios.get(imageUrl, {
                        responseType: "arraybuffer",
                        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
                    });

                    // Step 3: Find or create Slack thread
                    let threadTs;
                    const existingMapping = await prisma.mapping.findFirst({
                        where: { phoneNumber: hashPhone(from), teamId }
                    });

                    if (!existingMapping) {
                        const result = await slackClient.chat.postMessage({
                            channel: SLACK_CHANNEL,
                            text: `🟢 New WhatsApp conversation from ${from}`
                        });
                        threadTs = result.ts.toString();
                        await prisma.mapping.create({
                            data: {
                                phoneNumber: hashPhone(from),
                                sendTo: from,
                                threadTs: result.ts.toString(),
                                teamId
                            }
                        });
                    } else {
                        threadTs = existingMapping.threadTs;
                    }


                    // Step 4: Upload image to Slack using uploadV2
                    // Check if caption starts with @all — broadcast image
                    if (caption.trim().toLowerCase().startsWith("@all")) {
                        const broadcastCaption = caption.trim().substring(4).trim();

                        // Post image in main channel
                        await slackClient.files.uploadV2({
                            channel_id: SLACK_CHANNEL,
                            initial_comment: `📢 *${from} (WhatsApp):* ${broadcastCaption || "sent an image"}`,
                            file: Buffer.from(imageBuffer.data),
                            filename: "whatsapp-image.jpg"
                        });

                        // Also post in thread for reply support
                        await slackClient.files.uploadV2({
                            channel_id: SLACK_CHANNEL,
                            thread_ts: threadTs,
                            initial_comment: `📢 *${from}:* ${broadcastCaption || "sent an image"}`,
                            file: Buffer.from(imageBuffer.data),
                            filename: "whatsapp-image.jpg"
                        });
                    } else {
                        // Normal image → thread only
                        await slackClient.files.uploadV2({
                            channel_id: SLACK_CHANNEL,
                            thread_ts: threadTs,
                            initial_comment: `📱 ${from}${caption ? ": " + caption : " sent an image"}`,
                            file: Buffer.from(imageBuffer.data),
                            filename: "whatsapp-image.jpg"
                        });
                    }

                    console.log("✅ Image from WhatsApp posted to Slack thread");
                } catch (err) {
                    console.error("❌ Image WA→Slack error:", err.message);
                }

                return res.sendStatus(200);
            }

            // 2b. Ignore other non-text (audio, video, etc)
            if (!message.text) {
                console.log("⚠️ Non-text ignored");
                return res.sendStatus(200);
            }

            // 3. Extract messageId
            const messageId = message.id;
            if (!messageId) return res.sendStatus(200);

            // 4. Dedup
            const exists = await prisma.processedMessage.findUnique({
                where: { messageId }
            });

            if (exists) {
                console.log("⚠️ Duplicate ignored:", messageId);
                return res.sendStatus(200);
            }

            await prisma.processedMessage.create({
                data: { messageId }
            });

            // 5. Normalize data
            const from = message.from?.toString().trim();
            const text = message.text.body;

            // ===============================
            // 🔹 @all BROADCAST FROM WA
            // ===============================
            if (text.trim().toLowerCase().startsWith("@all")) {
                const broadcastMsg = text.trim().substring(4).trim();

                const consentRecord = await prisma.consent.findUnique({
                    where: { phoneNumber: hashPhone(from) }
                });

                if (consentRecord) {
                    const teamId = consentRecord.teamId;
                    const workspaceInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
                    const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;
                    const SLACK_CHANNEL = workspaceInstall?.channelId || process.env.SLACK_CHANNEL_ID;
                    const { WebClient } = require("@slack/web-api");
                    const slackClient = new WebClient(botToken);

                    // Post in main channel
                    await slackClient.chat.postMessage({
                        channel: SLACK_CHANNEL,
                        text: `📢 *${from} (WhatsApp):* ${broadcastMsg}`
                    });

                    // Also post in their existing thread so replies work
                    const existingMapping = await prisma.mapping.findFirst({
                        where: { phoneNumber: hashPhone(from), teamId }
                    });

                    if (existingMapping) {
                        await slackClient.chat.postMessage({
                            channel: SLACK_CHANNEL,
                            text: `📢 *${from}:* ${broadcastMsg}`,
                            thread_ts: existingMapping.threadTs
                        });
                    }

                    console.log("📢 Broadcast from WA:", maskPhone(from));
                }

                return res.sendStatus(200);
            }

            // ===============================
            // 🔹 STOP / OPT-OUT DETECTION
            // ===============================
            const stopWords = ["STOP", "UNSUBSCRIBE", "STOPSLACK"];
            if (stopWords.includes(text.trim().toUpperCase())) {
                const existingConsent = await prisma.consent.findUnique({
                    where: { phoneNumber: hashPhone(from) }
                });

                if (existingConsent) {
                    // Get mapping BEFORE deleting (needed for thread notification)
                    const teamIdForOptout = existingConsent.teamId || "default_workspace";
                    const mappingBeforeDelete = await prisma.mapping.findFirst({
                        where: { phoneNumber: hashPhone(from), teamId: teamIdForOptout }
                    });
                    // Send WA confirmation BEFORE deleting data
                    try {
                        await axios.post(
                            `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
                            {
                                messaging_product: "whatsapp",
                                to: from,
                                type: "text",
                                text: {
                                    body: `✅ You have been successfully unsubscribed.\n\nYou will no longer receive messages from this Slack team.\n\nIf you'd like to reconnect in the future, ask the team to invite you again.`
                                }
                            },
                            {
                                headers: {
                                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                                    "Content-Type": "application/json"
                                }
                            }
                        );
                    } catch (err) {
                        console.error("❌ Opt-out WA confirmation failed:", err.message);
                    }

                    // NOW delete all data
                    await prisma.consent.delete({ where: { phoneNumber: hashPhone(from) } });
                    await prisma.mapping.deleteMany({ where: { phoneNumber: hashPhone(from) } });
                    await prisma.pendingConnection.deleteMany({ where: { phoneNumber: hashPhone(from) } });
                    // Notify Slack thread
                    const teamId = existingConsent.teamId || "default_workspace";
                    const workspaceInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
                    const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;
                    const SLACK_CHANNEL = workspaceInstall?.channelId || process.env.SLACK_CHANNEL_ID;
                    const { WebClient } = require("@slack/web-api");
                    const slackClient = new WebClient(botToken);

                    await slackClient.chat.postMessage({
                        channel: SLACK_CHANNEL,
                        thread_ts: mappingBeforeDelete?.threadTs,
                        text: `🔴 *${from} has opted out.* They sent "${text.trim()}". No further messages will be delivered to or from this number.`
                    });

                    console.log("🔴 Opt-out received from:", (maskPhone(from)));
                    await auditLog(hashPhone(from), "UNSUBSCRIBED", "whatsapp_user", existingConsent.teamId || "default_workspace");
                } else {
                    console.log("⚠️ STOP from unknown number:", maskPhone(from));
                }

                return res.sendStatus(200);
            }

            // ===============================
            // 🔹 JOIN DETECTION
            // ===============================
            if (text.trim().toUpperCase().startsWith("JOIN")) {
                const parts = text.trim().split(/[\s-]+/);
                const receivedToken = parts[1];

                if (!receivedToken) {
                    console.log("⚠️ JOIN received without token, ignoring");
                    return res.sendStatus(200);
                }

                const pending = await prisma.pendingConnection.findUnique({
                    where: { token: receivedToken }
                });

                if (!pending) {
                    console.log("⚠️ Invalid token:", receivedToken);
                    return res.sendStatus(200);
                }

                if (new Date() > pending.expiresAt) {
                    console.log("⏰ Token expired for:", (maskPhone(from)));
                    await prisma.pendingConnection.delete({ where: { token: receivedToken } });
                    return res.sendStatus(200);
                }

                if (pending.phoneNumber !== hashPhone(from)) {
                    console.log("🚫 Token phone mismatch. Expected:", pending.phoneNumber, "Got:", hashPhone(from));
                    return res.sendStatus(200);
                }

                console.log("✅ JOIN verified with token:", receivedToken, "for:", maskPhone(from));

                // Check if number already connected to a DIFFERENT workspace
                const existingConsent = await prisma.consent.findUnique({
                    where: { phoneNumber: hashPhone(from) }
                });

                if (existingConsent && existingConsent.teamId !== pending.teamId) {
                    const oldTeamId = existingConsent.teamId;

                    // Get old workspace mapping for thread notification
                    const oldMapping = await prisma.mapping.findFirst({
                        where: { phoneNumber: hashPhone(from), teamId: oldTeamId }
                    });

                    // Notify old workspace
                    try {
                        const oldWorkspace = await prisma.workspaceInstall.findUnique({ where: { teamId: oldTeamId } });
                        const oldBotToken = oldWorkspace?.botToken || process.env.SLACK_BOT_TOKEN;
                        const oldChannel = oldWorkspace?.channelId || process.env.SLACK_CHANNEL_ID;
                        const { WebClient: OldClient } = require("@slack/web-api");
                        const oldSlack = new OldClient(oldBotToken);
                        await oldSlack.chat.postMessage({
                            channel: oldChannel,
                            thread_ts: oldMapping?.threadTs,
                            text: `⚠️ *${from} has switched to another workspace.* They joined a different Slack team and have been automatically disconnected from this workspace. All their data has been deleted.`
                        });
                    } catch (err) {
                        console.error("❌ Old workspace notification failed:", err.message);
                    }

                    // Notify WA user of workspace switch
                    try {
                        await axios.post(
                            `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
                            {
                                messaging_product: "whatsapp",
                                to: from,
                                type: "text",
                                text: {
                                    body: `🔄 You have been moved to a new Slack workspace.\n\nYour previous connection has been automatically removed. You are now connected to the new team.`
                                }
                            },
                            { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
                        );
                    } catch (err) {
                        console.error("❌ WA workspace switch notification failed:", err.message);
                    }

                    // Delete old workspace data
                    await prisma.mapping.deleteMany({ where: { phoneNumber: hashPhone(from), teamId: oldTeamId } });
                    await auditLog(hashPhone(from), "WORKSPACE_SWITCHED", "whatsapp_user", oldTeamId);
                    console.log("🔄 Workspace switch detected for:", maskPhone(from), "from:", oldTeamId, "to:", pending.teamId);
                }

                await prisma.consent.upsert({
                    where: { phoneNumber: hashPhone(from) },
                    update: { consentGiven: true, teamId: pending.teamId },
                    create: { phoneNumber: hashPhone(from), consentGiven: true, teamId: pending.teamId }
                });

                await prisma.pendingConnection.delete({ where: { token: receivedToken } });
                console.log("✅ Consent granted and token cleaned up for:", (maskPhone(from)));
                await auditLog(hashPhone(from), "JOINED", "whatsapp_user", pending.teamId);
                // Notify Slack that user has joined
                try {
                    const joinTeamId = pending.teamId;
                    const joinWorkspace = await prisma.workspaceInstall.findUnique({ where: { teamId: joinTeamId } });
                    const joinBotToken = joinWorkspace?.botToken || process.env.SLACK_BOT_TOKEN;
                    const joinChannel = joinWorkspace?.channelId || process.env.SLACK_CHANNEL_ID;
                    const { WebClient: JoinClient } = require("@slack/web-api");
                    const joinSlack = new JoinClient(joinBotToken);
                    await joinSlack.chat.postMessage({
                        channel: joinChannel,
                        text: `✅ *${from} has joined the bridge!*\nThey confirmed via WhatsApp. You can now message them by replying in their thread.`
                    });
                } catch (err) {
                    console.error("❌ Join notification failed:", err.message);
                }

                // Send welcome message explaining the session rules
                try {
                    await axios.post(
                        `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
                        {
                            messaging_product: "whatsapp",
                            to: from,
                            type: "text",
                            text: {
                                body: `✅ You're now connected to the team on Slack.\n\nHere's how it works:\n• This conversation is active for *24 hours* from your last message.\n• To keep the conversation going after 24 hours, simply send any message to restart the session.\n• To stop receiving messages at any time, reply *UNSUBSCRIBE*.\n\nFeel free to start messaging!`
                            }
                        },
                        {
                            headers: {
                                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                                "Content-Type": "application/json"
                            }
                        }
                    );
                    console.log("✅ Welcome message sent to:", (maskPhone(from)));
                } catch (err) {
                    console.error("❌ Welcome message failed:", err.response?.data || err.message);
                }

                return res.sendStatus(200);
            }


            // ===============================
            // 🔴 CONSENT ENFORCEMENT
            // ===============================
            const consent = await prisma.consent.findUnique({
                where: { phoneNumber: hashPhone(from) }
            });

            if (!consent || !consent.consentGiven) {
                console.log("🚫 Blocked (no consent):", (maskPhone(from)));
                return res.sendStatus(200);
            }

            console.log("📩 WhatsApp:", (maskPhone(from)), text);
            console.log("📌 messageId:", messageId);

            // 6. Thread logic — get teamId from consent
            const teamId = consent.teamId || "default_workspace";
            const workspaceInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
            const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;
            const SLACK_CHANNEL = workspaceInstall?.channelId || process.env.SLACK_CHANNEL_ID;
            const { WebClient } = require("@slack/web-api");
            const slackClient = new WebClient(botToken);

            const existingMapping = await prisma.mapping.findFirst({
                where: { phoneNumber: hashPhone(from), teamId }
            });

            if (!existingMapping) {
                const result = await slackClient.chat.postMessage({
                    channel: SLACK_CHANNEL,
                    text: `🟢 New WhatsApp conversation from ${from}\n${text}`
                });

                await prisma.mapping.create({
                    data: {
                        phoneNumber: hashPhone(from),
                        sendTo: from,
                        threadTs: result.ts.toString(),
                        teamId
                    }
                });

                console.log("🧵 Thread created for", (maskPhone(from)), "→", result.ts);

            } else {
                await slackClient.chat.postMessage({
                    channel: SLACK_CHANNEL,
                    text: `📱 ${from}: ${text}`,
                    thread_ts: existingMapping.threadTs
                });
            }

            res.sendStatus(200);

            // AFTER
        } catch (err) {
            Sentry.captureException(err);
            console.error("Webhook error:", err.message);
            res.sendStatus(500);
        }
    });
    Sentry.setupExpressErrorHandler(expressApp);
})();