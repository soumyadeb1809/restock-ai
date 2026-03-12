import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { saveAuthToken, getAuthToken, saveConsumptionSchedule, getConsumptionSchedule } from './db.js';
import { SwiggyClient } from './mcp_client.js';
import { analyzeOrderHistory } from './pattern_engine.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);

// Middleware to ensure the bot is completely private
bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.id !== ALLOWED_USER_ID) {
        // Silently ignore or warn unauthorized users
        console.warn(`Unauthorized access attempt from user ID: ${ctx.from?.id}`);
        return;
    }
    return next();
});

// Command: /start
bot.command('start', (ctx) => {
    ctx.reply(
        "👋 Welcome to RestockBot!\n\n" +
        "I'm your personal Swiggy Instamart assistant. I will learn your grocery patterns and remind you when you're running low.\n\n" +
        "To get started, send /login to securely connect your Swiggy account."
    );
});

// Command: /login
bot.command('login', (ctx) => {
    // We construct the Swiggy OAuth URL. 
    // Usually, this is documented, but we redirect to the whitelisted localhost.
    const oauthUrl = `https://mcp.swiggy.com/oauth/authorize?client_id=mcp_client&redirect_uri=http://localhost/callback&response_type=code`;

    ctx.reply(
        "🔐 **Authentication Time**\n\n" +
        "1. Click the link below to log into Swiggy on your mobile browser.\n" +
        "2. After logging in, the browser will try to redirect to `localhost` and show an error (e.g., 'Site cannot be reached'). This is expected!\n" +
        "3. Copy the ENTIRE URL from your browser's address bar (it will look like `http://localhost/callback?code=...`).\n" +
        "4. Paste that URL back here to me.",
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: "Login to Swiggy", url: oauthUrl }]]
            }
        }
    );
});

// Command: /analyze (Force an analysis of history)
bot.command('analyze', async (ctx) => {
    ctx.reply("🔍 Connecting to Swiggy to fetch your latest order history...");

    const token = await getAuthToken(ctx.from.id);
    if (!token) {
        return ctx.reply("❌ You are not logged in. Please type /login to authenticate first.");
    }

    const swiggy = new SwiggyClient();
    const connected = await swiggy.connect(token);

    if (!connected) {
        return ctx.reply("❌ Failed to connect to Swiggy. Your token might have expired. Try /login again.");
    }

    try {
        // Fetch history
        const historyResponse = await swiggy.getOrderHistory();

        // Extract basic orders or default to empty array
        const rawHistory = historyResponse.content ? historyResponse.content : (historyResponse || []);
        const orderList = Array.isArray(rawHistory) ? rawHistory : (rawHistory.orders || []);

        ctx.reply(`✅ Found ${orderList.length} total past orders. Fetching full details for the 20 most recent orders...`);

        // Enforce limit of latest 20 orders to save LLM context window limits
        const recentOrders = orderList.slice(0, 20);
        const detailedOrders = [];

        // Fetch deep details for each order
        for (const order of recentOrders) {
            try {
                // Swiggy order structures vary; assuming 'id' or 'order_id' exists
                const orderId = order.id || order.order_id;
                if (orderId) {
                    const details = await swiggy.getOrderDetails(orderId);
                    detailedOrders.push(details.content || details);
                }
            } catch (err) {
                console.warn(`Failed to fetch details for an order: ${err.message}`);
            }
        }

        ctx.reply(`✅ Fetched full details for ${detailedOrders.length} orders. Now analyzing your consumption patterns and brand preferences using Claude...`);

        // Analyze the detailed array
        const schedule = await analyzeOrderHistory(detailedOrders);

        if (schedule && schedule.schedule) {
            await saveConsumptionSchedule(ctx.from.id, schedule);
            let replyText = "🧠 Analysis complete! Here are the recurring items I found:\n\n";
            for (const item of schedule.schedule) {
                replyText += `- **${item.itemName}** (Every ${item.frequencyDays} days)\n  _Search Query:_ ${item.searchQuery}\n  _Next expected order:_ ${new Date(item.nextSuggestedOrderAt).toDateString()}\n\n`;
            }
            ctx.reply(replyText, { parse_mode: 'Markdown' });
        } else {
            ctx.reply("⚠️ Hmm, I couldn't find any clear recurring grocery patterns in your recent orders. I will try again next week.");
        }

    } catch (e) {
        console.error("Analysis Error:", e);
        ctx.reply("❌ An error occurred during analysis. Check the server logs.");
    } finally {
        await swiggy.disconnect();
    }
});

// Handle incoming URLs (The token capture flow)
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    // Check if the user pasted the localhost callback URL
    if (text.startsWith('http://localhost/callback?code=')) {
        try {
            const url = new URL(text);
            const code = url.searchParams.get('code');

            if (code) {
                // In a true OAuth flow, we exchange 'code' for an 'access_token'.
                // If Swiggy returns the long-lived token directly in the query as the 'code' parameter 
                // (some simple MCPs do this), we use it directly. Assuming it needs a direct exchange:

                // For MVP: We will assume the 'code' is the token we pass to the Bearer header
                // or we implement the token exchange if Swiggy strictly requires a POST to `/oauth/token`.

                // Save it to Firebase
                const success = await saveAuthToken(ctx.from.id, code);

                if (success) {
                    ctx.reply("✅ Successfully captured your Swiggy authentication token! You're ready to go. Type /analyze to build your grocery profile.");
                } else {
                    ctx.reply("❌ Failed to save the token to the database. Check server logs.");
                }
            } else {
                ctx.reply("⚠️ I didn't find a code in that URL. Please try logging in again.");
            }
        } catch (e) {
            ctx.reply("⚠️ That doesn't look like a valid URL. Please paste the exact URL from your browser after logging in.");
        }
    }
});

export default bot;
