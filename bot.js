import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { saveAuthToken, getAuthToken, saveConsumptionSchedule, getConsumptionSchedule, savePreferredAddress, getPreferredAddress } from './db.js';
import { SwiggyClient } from './mcp_client.js';
import { analyzeOrderHistory } from './pattern_engine.js';
import { handleUserQuery } from './agent_brain.js';

dotenv.config();

// PKCE helpers
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Temporary in-memory store for the PKCE code_verifier (single-user MVP)
// This is cleared after successful login
let pendingCodeVerifier = null;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);

// Middleware to ensure the bot is completely private
bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.id !== ALLOWED_USER_ID) {
        // Silently ignore or warn unauthorized users
        console.warn(`Unauthorized access attempt from user ID: ${ctx.from?.id} `);
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
bot.command('login', async (ctx) => {
    // Generate PKCE code_verifier and code_challenge (required by Swiggy's OAuth)
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Store verifier in memory so we can use it when the user pastes the callback URL
    pendingCodeVerifier = codeVerifier;

    // Correct Swiggy OAuth endpoint (discovered via .well-known/oauth-authorization-server)
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: 'restock-bot',
        redirect_uri: 'http://localhost/callback',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        scope: 'mcp:tools'
    });
    const oauthUrl = `https://mcp.swiggy.com/auth/authorize?${params.toString()}`;

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
        // Fetch history using the new deep scraper (target 20 orders)
        const orderList = await swiggy.getDeepOrderHistory(20);

        if (orderList.length === 0) {
            ctx.reply("⚠️ No orders found in your history. I'll rely on your 'Go To Items' if available.");
        } else {
            ctx.reply(`✅ Found ${orderList.length} total past orders. Fetching full details for each...`);
        }

        const detailedOrders = [];

        // Process orderList directly (it already contains items!)
        for (const order of orderList) {
            const items = order.items || order.order_items || [];
            if (items.length > 0) {
                detailedOrders.push({
                    orderId: order.orderId || order.id || order.order_id,
                    createdAt: order.createdAt || order.order_time,
                    items: items.map(i => ({ name: i.name || i.item_name, quantity: i.quantity || i.item_quantity }))
                });
            }
        }

        console.log(`[Analyze] Successfully processed ${detailedOrders.length} orders from history.`);

        // Save history to debug folder for visibility
        fs.writeFileSync(`debug/latest_analyze_history.json`, JSON.stringify(orderList, null, 2));

        ctx.reply(`✅ Fetched full details for ${detailedOrders.length} orders. Now analyzing your consumption patterns and brand preferences using Gemini...`);

        // Fetch Go To Items as a fallback/additional signal
        let gotoItems = [];
        try {
            const addressId = await getPreferredAddress(ctx.from.id);
            if (addressId) {
                const gotoResponse = await swiggy.getGoToItems(addressId);
                const gotoText = gotoResponse.content?.[0]?.text;
                const parsedGoto = gotoText ? JSON.parse(gotoText) : {};
                gotoItems = parsedGoto.data?.items || [];
                console.log(`[Analyze] Found ${gotoItems.length} Go To items.`);
            }
        } catch (gotoErr) {
            console.warn("Failed to fetch Go To items:", gotoErr.message);
        }

        // Analyze the detailed array + goto items
        const schedule = await analyzeOrderHistory(detailedOrders, gotoItems);

        if (schedule && schedule.schedule) {
            await saveConsumptionSchedule(ctx.from.id, schedule);
            console.log(`[Analyze] Generated schedule with ${schedule.schedule.length} items.`);

            let replyText = "🧠 Analysis complete! Here are the recurring items I found:\n\n";
            for (const item of schedule.schedule) {
                replyText += `- **${item.itemName}** (Every ${item.frequencyDays} days)\n  _Search Query:_ ${item.searchQuery}\n  _Next expected order:_ ${new Date(item.nextSuggestedOrderAt).toDateString()}\n\n`;
            }

            try {
                await ctx.reply(replyText, { parse_mode: 'Markdown' });
            } catch (markdownError) {
                console.warn("[Analyze] Markdown parsing failed, falling back to plain text:", markdownError.message);
                await ctx.reply(replyText);
            }
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

// Command: /address (Select preferred delivery address)
bot.command('address', async (ctx) => {
    const token = await getAuthToken(ctx.from.id);
    if (!token) {
        return ctx.reply("❌ Please /login first to view your addresses.");
    }

    const swiggy = new SwiggyClient();
    const connected = await swiggy.connect(token);
    if (!connected) {
        return ctx.reply("❌ Connection to Swiggy failed. Try /login again.");
    }

    try {
        ctx.reply("📍 Fetching your saved addresses...");
        const response = await swiggy.getAddresses();
        const textContent = response.content?.[0]?.text;

        let addresses = [];
        try {
            const parsed = textContent ? JSON.parse(textContent) : {};
            // Try different possible structures
            addresses = parsed.data?.addresses || parsed.addresses || (Array.isArray(parsed) ? parsed : []);
        } catch (e) {
            console.warn("Failed to parse addresses JSON:", e);
        }

        if (addresses.length === 0) {
            return ctx.reply("❌ No saved addresses found in your Swiggy account.");
        }

        const buttons = addresses.map(addr => ([{
            text: `${addr.addressTag || addr.addressCategory || 'Address'}: ${addr.addressLine}`,
            callback_data: `sel_addr:${addr.id}`
        }]));

        ctx.reply("🎯 Please select your **preferred delivery address** for RestockBot:", {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buttons
            }
        });
    } catch (e) {
        console.error("Address Fetch Error:", e);
        ctx.reply("❌ Error fetching addresses. Check logs.");
    } finally {
        await swiggy.disconnect();
    }
});

// Handle address selection button clicks
bot.action(/^sel_addr:(.+)$/, async (ctx) => {
    const addressId = ctx.match[1];
    const success = await savePreferredAddress(ctx.from.id, addressId);

    if (success) {
        await ctx.answerCbQuery("Address saved!");
        await ctx.editMessageText(`✅ **Preferred address set!**\n\nI will now use this location for all search and restocking queries.`);
    } else {
        await ctx.answerCbQuery("Error saving address.");
        await ctx.reply("❌ Failed to save address selection. Please try /address again.");
    }
});

// Handle incoming URLs (The token capture flow) and general natural language queries
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    // 1. Check if the user pasted the localhost callback URL
    if (text.startsWith('http://localhost/callback')) {
        try {
            const url = new URL(text);
            const code = url.searchParams.get('code');

            if (!code) {
                return ctx.reply("⚠️ I didn't find a code in that URL. Please try /login again.");
            }

            if (!pendingCodeVerifier) {
                return ctx.reply("⚠️ Session expired. Please type /login to start fresh.");
            }

            ctx.reply("🔄 Exchanging code for access token...");

            // Exchange auth code for access token using Swiggy's token endpoint
            const tokenResponse = await fetch('https://mcp.swiggy.com/auth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: 'http://localhost/callback',
                    client_id: 'restock-bot',
                    code_verifier: pendingCodeVerifier,
                }).toString()
            });

            const tokenData = await tokenResponse.json();

            if (!tokenResponse.ok || !tokenData.access_token) {
                console.error("Token exchange failed:", tokenData);
                return ctx.reply(`❌ Swiggy rejected the token exchange: ${tokenData.error_description || tokenData.error || 'Unknown error'}. Please try /login again.`);
            }

            // Clear the pending verifier
            pendingCodeVerifier = null;

            // Save the full token object (includes access_token + refresh_token if present)
            const success = await saveAuthToken(ctx.from.id, tokenData);

            if (success) {
                ctx.reply("✅ Successfully authenticated with Swiggy! You're ready to go.\n\nType /analyze to build your grocery profile or just ask me a question!");
            } else {
                ctx.reply("❌ Failed to save the token to the database. Check server logs.");
            }
        } catch (e) {
            console.error("Token capture error:", e);
            ctx.reply("⚠️ Something went wrong. Please paste the exact URL from your browser after logging in, or try /login again.");
        }
    }
    // 2. Otherwise, treat as a general conversational query
    else {
        try {
            const token = await getAuthToken(ctx.from.id);
            if (!token) {
                return ctx.reply("💬 I'd love to help, but you need to /login first so I can access Swiggy for you!");
            }

            const swiggy = new SwiggyClient();
            const connected = await swiggy.connect(token);

            if (!connected) {
                return ctx.reply("❌ I couldn't connect to Swiggy. Your token might be expired. Please /login again.");
            }

            try {
                // Let the user know we are working on it
                ctx.reply("🤔 Let me check that for you...");

                const addressId = await getPreferredAddress(ctx.from.id);
                const response = await handleUserQuery(swiggy, text, addressId);

                try {
                    await ctx.reply(response, { parse_mode: 'Markdown' });
                } catch (markdownError) {
                    console.warn("Markdown parsing failed, falling back to plain text:", markdownError.message);
                    await ctx.reply(response);
                }
            } finally {
                await swiggy.disconnect();
            }
        } catch (e) {
            console.error("General Query Error:", e);
            ctx.reply("❌ I encountered an error while searching Swiggy. Please try again later.");
        }
    }
});

export default bot;
