const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

require("https").globalAgent.options.family = 4;

const express = require("express");
// const app = express();
const axios = require("axios");
require("dotenv").config();

const { App, ExpressReceiver } = require("@slack/bolt");

const threadMap = {};

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

    if (subcommand === "invite") {
        const number = parts[1];

        if (!number || !/^\d{10,15}$/.test(number)) {
            return respond("Usage: /whatsapp invite 91XXXXXXXXXX");
        }

        const waLink = `https://wa.me/${number}?text=JOIN`;

        return respond({
            response_type: "ephemeral",
            text: `Click to connect WhatsApp:\n${waLink}`
        });
    }

    if (subcommand === "reply") {
        const message = parts.slice(1).join(" ");

        if (!message) {
            return respond("Usage: /whatsapp1 reply <message>");
        }

        // Get thread ID
        const threadTs = command.thread_ts || command.ts;

        console.log("🧵 Reply in thread:", threadTs);

        // Find phone number from threadMap
        const number = Object.keys(threadMap).find(
            key => threadMap[key] === threadTs
        );

        if (!number) {
            return respond("❌ This thread is not linked to any WhatsApp user");
        }

        respond(`📤 Sending to ${number}...`);

        sendWhatsAppMessage(number, message);

        return;
    }

    return respond("Unknown command");
});

// ===============================
// 🔹 SLACK MESSAGE LISTENER (THREAD REPLIES)
// ===============================
slackApp.message(async ({ message }) => {
    // Ignore bot messages
    if (message.subtype || message.bot_id) return;

    // Only process thread messages

    if (!message.thread_ts) return;

    const threadTs = message.thread_ts.toString();

    console.log("🧠 threadTs incoming:", threadTs);
    console.log("🧠 current threadMap:", threadMap);
    const userMessage = message.text;

    console.log("💬 Slack thread message:", userMessage);

    const number = Object.keys(threadMap).find(
        key => threadMap[key].toString() === threadTs
    );

    if (!number) {
        console.log("❌ No mapping for this thread");
        return;
    }

    console.log("📤 Sending to WhatsApp:", number);

    await sendWhatsAppMessage(number, userMessage);
});

// ===============================
// 🔹 SEND WHATSAPP MESSAGE
// ===============================
async function sendWhatsAppMessage(to, message) {
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

        console.log("WhatsApp sent:", response.data);
    } catch (error) {
        console.error("❌ WhatsApp Error FULL:", JSON.stringify(error.response?.data, null, 2));
    }
}



// ===============================
// 🔹 START SERVER (SINGLE PORT)
// ===============================
(async () => {
    await receiver.app.listen(3000);
    console.log("⚡ Slack Bolt running on port 3000");

    const expressApp = receiver.app;

    // expressApp.post("/slack/events", (req, res) => {
    //     if (req.body.type === "url_verification") {
    //         console.log("🔐 Slack URL verification");
    //         return res.status(200).send(req.body.challenge);
    //     }
    // });
    // Attach ONLY your routes (not whole app)
    expressApp.get("/", (req, res) => res.send("Server is live"));

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

            if (message) {
                const from = message.from;
                const text = message.text?.body;

                console.log("📩 WhatsApp:", from, text);

                // const { WebClient } = require("@slack/web-api");
                // const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
                const slackClient = slackApp.client;
                const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;

                if (!threadMap[from]) {
                    const result = await slackClient.chat.postMessage({
                        channel: SLACK_CHANNEL,
                        text: `🟢 New WhatsApp conversation from ${from}\n${text}`
                    });

                    threadMap[from] = result.ts.toString();
                    console.log("🧵 Thread created for", from, "→", result.ts);

                } else {
                    await slackClient.chat.postMessage({
                        channel: SLACK_CHANNEL,
                        text: `📱 ${from}: ${text}`,
                        thread_ts: threadMap[from]
                    });
                }
            }

            res.sendStatus(200);
        } catch (err) {
            console.error("Webhook error:", err.message);
            res.sendStatus(500);
        }
    });
})();