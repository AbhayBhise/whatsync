const Sentry = require("@sentry/node");

Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1.0
});
console.log("🔍 SENTRY_DSN:", process.env.SENTRY_DSN ? "✅ loaded" : "❌ MISSING");