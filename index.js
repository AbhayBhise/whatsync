const dns = require("dns");
const crypto = require("crypto");
dns.setDefaultResultOrder("ipv4first");

require("https").globalAgent.options.family = 4;

const express = require("express");
// const app = express();
const axios = require("axios");
require("dotenv").config();

const { App, ExpressReceiver } = require("@slack/bolt");

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const QRCode = require("qrcode");
// Auto-clean expired PendingConnections every 2 minutes
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
receiver.app.use(express.json());
receiver.app.use(express.urlencoded({ extended: true }));

// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));
receiver.app.use((req, res, next) => {
    console.log("👉 Incoming request:", req.method, req.url);
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

        const token = crypto.randomBytes(16).toString("hex");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        try {
            await prisma.pendingConnection.create({
                data: { phoneNumber: number, token, teamId, expiresAt }
            });
        } catch (err) {
            console.log("⚠️ DB insert failed:", err.message);
        }

        const BUSINESS_NUMBER = process.env.WHATSAPP_BUSINESS_NUMBER;
        const waLink = `https://wa.me/${BUSINESS_NUMBER}?text=JOIN-${token}`;

        // Generate QR code as PNG buffer
        const qrBuffer = await QRCode.toBuffer(waLink, { width: 300, margin: 2 });

        // Upload QR to Slack
        const { WebClient } = require("@slack/web-api");
        const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

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
            return `• *${c.phoneNumber}* — connected since ${since}${mapping ? ` — thread: ${mapping.threadTs}` : ""}`;
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

        const BUSINESS_NUMBER = "15551855876";

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

        const consent = await prisma.consent.findUnique({
            where: { phoneNumber: number }
        });

        if (!consent) {
            return respond({
                response_type: "ephemeral",
                text: `⚠️ ${number} is not connected.`
            });
        }

        // GDPR: delete all data
        await prisma.consent.delete({ where: { phoneNumber: number } });
        await prisma.mapping.deleteMany({ where: { phoneNumber: number } });
        await prisma.pendingConnection.deleteMany({ where: { phoneNumber: number } });

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

        const number = mapping.phoneNumber;

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
        "• `/whatsapp1 reply <message>` — reply from a thread"
    );
});

// ===============================
// 🔹 SLACK FILE SHARE HANDLER
// ===============================
slackApp.event("message", async ({ event }) => {
    if (event.subtype !== "file_share") return;
    if (!event.thread_ts) return;
    if (event.bot_id) return;

    console.log("📎 File share event received:", JSON.stringify({
        files: event.files?.map(f => ({ name: f.name, mimetype: f.mimetype })),
        thread_ts: event.thread_ts,
        team: event.team
    }));

    const threadTs = event.thread_ts.toString();
    const teamId = event.team || event.user_team || "default_workspace";
    const mapping = await prisma.mapping.findFirst({
        where: { threadTs }
    });

    if (!mapping) {
        console.log("❌ No mapping for this thread");
        return;
    }

    const number = mapping.phoneNumber;

    for (const file of (event.files || [])) {
        if (!file.mimetype?.startsWith("image/")) {
            console.log("⚠️ Non-image file ignored:", file.mimetype);
            continue;
        }

        try {
            const botToken = process.env.SLACK_BOT_TOKEN;

            // Step 1: Download from Slack using native https (respects IPv4 setting)
            const imageRes = await new Promise((resolve, reject) => {
                const https = require("https");
                const url = new URL(file.url_private);
                const options = {
                    hostname: url.hostname,
                    path: url.pathname + url.search,
                    headers: { Authorization: `Bearer ${botToken}` },
                    family: 4
                };
                https.get(options, (res) => {
                    const chunks = [];
                    res.on("data", chunk => chunks.push(chunk));
                    res.on("end", () => resolve({ data: Buffer.concat(chunks) }));
                    res.on("error", reject);
                }).on("error", reject);
            });

            // Step 2: Upload to Meta
            const FormData = require("form-data");
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
                console.log("✅ Image sent Slack→WhatsApp:", number);
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
    if (!message.thread_ts) return;

    const threadTs = message.thread_ts.toString();
    const teamId = message.team;

    const mapping = await prisma.mapping.findFirst({
        where: { threadTs, teamId }
    });

    if (!mapping) {
        console.log("❌ No mapping for this thread");
        return;
    }

    const number = mapping.phoneNumber;

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

                // Step 1: Download image from Slack
                const imageRes = await axios.get(file.url_private, {
                    responseType: "arraybuffer",
                    headers: { Authorization: `Bearer ${botToken}` }
                });

                // Step 2: Upload to Meta media endpoint
                const FormData = require("form-data");
                const form = new FormData();
                form.append("file", Buffer.from(imageRes.data), {
                    filename: file.name || "image.jpg",
                    contentType: file.mimetype
                });
                form.append("type", "image/jpeg");
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

                console.log("✅ Image sent from Slack → WhatsApp:", number);
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
        res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h1>Whatsync Bridge</h1>
        <p>Connect WhatsApp to your Slack workspace</p>
        <a href="https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=channels:history,chat:write,commands,files:read,files:write&redirect_uri=${appUrl}/slack/oauth_redirect"
           style="background:#4A154B;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:16px">
           Add to Slack
        </a>
        </body></html>
    `);
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
                update: { botToken: data.access_token, teamName: data.team.name },
                create: { teamId: data.team.id, botToken: data.access_token, teamName: data.team.name }
            });

            console.log("✅ OAuth install complete for:", data.team.name);
            res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:50px">
            <h1>✅ Whatsync installed!</h1>
            <p>Go back to Slack and use <b>/whatsapp1</b> in any channel.</p>
            </body></html>
        `);
        } catch (err) {
            console.error("OAuth redirect error:", err.message);
            res.status(500).send("Installation failed");
        }
    });
    expressApp.get("/debug-env", (req, res) => {
        res.json({
            clientId: process.env.SLACK_CLIENT_ID,
            clientIdLength: process.env.SLACK_CLIENT_ID?.length,
            hasClientSecret: !!process.env.SLACK_CLIENT_SECRET,
            appUrl: process.env.APP_URL
        });
    });
    expressApp.get("/test-slack", async (req, res) => {
        try {
            await axios.post(process.env.SLACK_WEBHOOK_URL, {
                text: "Webhook working"
            });
            res.send("Message sent to Slack");
        } catch (err) {
            console.error(err.message);
            res.status(500).send("Error sending message");
        }
    });

    // WhatsApp webhook verify

    expressApp.get("/webhook", (req, res) => {
        const verify_token = "verify_token";

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
                const consent = await prisma.consent.findUnique({ where: { phoneNumber: from } });
                console.log("🔍 Consent lookup for:", from, "→ result:", consent);
                if (!consent || !consent.consentGiven) {
                    console.log("🚫 Blocked image (no consent):", from);
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
                        where: { phoneNumber: from, teamId }
                    });

                    if (!existingMapping) {
                        const result = await slackClient.chat.postMessage({
                            channel: SLACK_CHANNEL,
                            text: `🟢 New WhatsApp conversation from ${from}`
                        });
                        threadTs = result.ts.toString();
                        await prisma.mapping.create({
                            data: { phoneNumber: from, threadTs, teamId }
                        });
                    } else {
                        threadTs = existingMapping.threadTs;
                    }


                    // Step 4: Upload image to Slack using uploadV2
                    await slackClient.files.uploadV2({
                        channel_id: SLACK_CHANNEL,
                        thread_ts: threadTs,
                        initial_comment: `📱 ${from}${caption ? ": " + caption : " sent an image"}`,
                        file: Buffer.from(imageBuffer.data),
                        filename: "whatsapp-image.jpg"
                    });

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
            // 🔹 STOP / OPT-OUT DETECTION
            // ===============================
            const stopWords = ["STOP", "UNSUBSCRIBE"];
            if (stopWords.includes(text.trim().toUpperCase())) {
                const existingConsent = await prisma.consent.findUnique({
                    where: { phoneNumber: from }
                });

                if (existingConsent) {
                    // Revoke consent
                    // GDPR: delete all data for this number
                    await prisma.consent.delete({ where: { phoneNumber: from } });
                    await prisma.mapping.deleteMany({ where: { phoneNumber: from } });
                    await prisma.pendingConnection.deleteMany({ where: { phoneNumber: from } });

                    // Notify Slack thread
                    const teamId = existingConsent.teamId || "default_workspace";
                    const workspaceInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
                    const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;
                    const SLACK_CHANNEL = workspaceInstall?.channelId || process.env.SLACK_CHANNEL_ID;
                    const { WebClient } = require("@slack/web-api");
                    const slackClient = new WebClient(botToken);

                    const existingMapping = await prisma.mapping.findFirst({
                        where: { phoneNumber: from, teamId }
                    });

                    await slackClient.chat.postMessage({
                        channel: SLACK_CHANNEL,
                        thread_ts: existingMapping?.threadTs,
                        text: `🔴 *${from} has opted out.* They sent "${text.trim()}". No further messages will be delivered to or from this number.`
                    });

                    console.log("🔴 Opt-out received from:", from);
                } else {
                    console.log("⚠️ STOP from unknown number:", from);
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
                    console.log("⏰ Token expired for:", from);
                    await prisma.pendingConnection.delete({ where: { token: receivedToken } });
                    return res.sendStatus(200);
                }

                if (pending.phoneNumber !== from) {
                    console.log("🚫 Token phone mismatch. Expected:", pending.phoneNumber, "Got:", from);
                    return res.sendStatus(200);
                }

                console.log("✅ JOIN verified with token:", receivedToken, "for:", from);

                await prisma.consent.upsert({
                    where: { phoneNumber: from },
                    update: { consentGiven: true, teamId: pending.teamId },
                    create: { phoneNumber: from, consentGiven: true, teamId: pending.teamId }
                });

                await prisma.pendingConnection.delete({ where: { token: receivedToken } });
                console.log("✅ Consent granted and token cleaned up for:", from);

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
                    console.log("✅ Welcome message sent to:", from);
                } catch (err) {
                    console.error("❌ Welcome message failed:", err.response?.data || err.message);
                }

                return res.sendStatus(200);
            }


            // ===============================
            // 🔴 CONSENT ENFORCEMENT
            // ===============================
            const consent = await prisma.consent.findUnique({
                where: { phoneNumber: from }
            });

            if (!consent || !consent.consentGiven) {
                console.log("🚫 Blocked (no consent):", from);
                return res.sendStatus(200);
            }

            console.log("📩 WhatsApp:", from, text);
            console.log("📌 messageId:", messageId);

            // 6. Thread logic — get teamId from consent
            const teamId = consent.teamId || "default_workspace";
            const workspaceInstall = await prisma.workspaceInstall.findUnique({ where: { teamId } });
            const botToken = workspaceInstall?.botToken || process.env.SLACK_BOT_TOKEN;
            const SLACK_CHANNEL = workspaceInstall?.channelId || process.env.SLACK_CHANNEL_ID;
            const { WebClient } = require("@slack/web-api");
            const slackClient = new WebClient(botToken);

            const existingMapping = await prisma.mapping.findFirst({
                where: { phoneNumber: from, teamId }
            });

            if (!existingMapping) {
                const result = await slackClient.chat.postMessage({
                    channel: SLACK_CHANNEL,
                    text: `🟢 New WhatsApp conversation from ${from}\n${text}`
                });

                await prisma.mapping.create({
                    data: {
                        phoneNumber: from,
                        threadTs: result.ts.toString(),
                        teamId
                    }
                });

                console.log("🧵 Thread created for", from, "→", result.ts);

            } else {
                await slackClient.chat.postMessage({
                    channel: SLACK_CHANNEL,
                    text: `📱 ${from}: ${text}`,
                    thread_ts: existingMapping.threadTs
                });
            }

            res.sendStatus(200);

        } catch (err) {
            console.error("Webhook error:", err.message);
            res.sendStatus(500);
        }
    });
})();