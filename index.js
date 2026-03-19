import { setDefaultResultOrder } from 'dns';
// Force IPv4 to prevent ETIMEDOUT errors on networks that don't support IPv6
setDefaultResultOrder('ipv4first');

import express from 'express';
import dotenv from 'dotenv';
import bot from './bot.js';
import { checkAndOrder } from './cron.js';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const TELEGRAM_ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;

// Render sets RENDER_EXTERNAL_URL automatically. 
// If it's present, we configure Webhooks. Otherwise, we use long-polling.
if (process.env.RENDER_EXTERNAL_URL) {
    const webhookPath = `/telegraf/${bot.secretPathComponent()}`;
    bot.telegram.setWebhook(`${WEBHOOK_DOMAIN}${webhookPath}`);
    console.log(`Setting Telegram webhook to ${WEBHOOK_DOMAIN}${webhookPath}`);
    app.use(bot.webhookCallback(webhookPath));
} else {
    console.log("Starting Telegram bot in Local Long-Polling Mode");
    bot.launch();
}

// Health check endpoint (for Render / ping services)
app.get('/ping', (req, res) => {
    res.send('Pong! RestockAI is alive.');
});

// Manual trigger for the daily cron job.
// A free service like cron-job.org or GitHub Actions should ping this endpoint every day at e.g., 9 AM.
app.get('/run-daily-check', async (req, res) => {

    // Simple API Key protection so not just anyone can trigger orders
    const providedKey = req.query.key;
    if (providedKey !== process.env.CRON_SECRET) {
        return res.status(401).send("Unauthorized");
    }

    try {
        if (!TELEGRAM_ALLOWED_USER_ID) {
            throw new Error("TELEGRAM_ALLOWED_USER_ID is missing from .env");
        }

        // Execute the daily check asynchronously in the background
        console.log("Triggering checkAndOrder in the background...");
        checkAndOrder(TELEGRAM_ALLOWED_USER_ID).catch(e => {
            console.error("Background Cron Task Error:", e);
        });
        
        // Immediately acknowledge the request so the cron service doesn't timeout
        res.status(202).send("Daily check started in background.");
    } catch (e) {
        console.error("Cron Endpoint Error:", e);
        res.status(500).send("Error starting daily check.");
    }
});

app.listen(PORT, () => {
    console.log(`RestockAI server is running on port ${PORT}`);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
