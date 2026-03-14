import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
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

// Helper: Run the full analysis flow in the background
async function runAnalysis(telegramUserId) {
    const token = await getAuthToken(telegramUserId);
    if (!token) {
        return bot.telegram.sendMessage(telegramUserId, "❌ You are not logged in. Please type /login to authenticate first.");
    }

    const swiggy = new SwiggyClient();
    const connected = await swiggy.connect(token);

    if (!connected) {
        return bot.telegram.sendMessage(telegramUserId, "❌ Failed to connect to Swiggy. Your token might have expired. Try /login again.");
    }

    try {
        console.log(`[Analyze] Starting background analysis for user ${telegramUserId}...`);

        // Fetch history using the new deep scraper (target 20 orders)
        const orderList = await swiggy.getDeepOrderHistory(20);

        if (orderList.length === 0) {
            await bot.telegram.sendMessage(telegramUserId, "⚠️ No orders found in your history. I'll rely on your 'Go To Items' if available.");
        }

        const detailedOrders = [];
        for (const order of orderList) {
            const items = order.items || order.order_items || [];
            if (items.length > 0) {
                const orderData = {
                    orderId: order.orderId || order.id || order.order_id,
                    createdAt: order.createdAt || order.order_time,
                    items: items.map(i => ({ name: i.name || i.item_name, quantity: i.quantity || i.item_quantity }))
                };
                detailedOrders.push(orderData);
            }
        }

        console.log(`[Analyze] Successfully processed ${detailedOrders.length} orders from history.`);
        fs.writeFileSync(`debug/latest_analyze_history.json`, JSON.stringify(detailedOrders, null, 2));

        // Fetch Go To Items
        let gotoItems = [];
        try {
            const addressId = await getPreferredAddress(telegramUserId);
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

        const schedule = await analyzeOrderHistory(detailedOrders, gotoItems);

        if (schedule && schedule.schedule) {
            await saveConsumptionSchedule(telegramUserId, schedule, { initiator: 'user' });

            // Send interactive completion message
            return bot.telegram.sendMessage(telegramUserId, "🧠 **Analysis Ready!**\n\nI've analyzed your Swiggy history and updated your grocery consumption profile. What would you like to do next?", {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📊 View Full Profile", callback_data: "view_full_analysis" }],
                        [{ text: "🛒 Check Today's Restock", callback_data: "check_restock_today" }]
                    ]
                }
            });
        } else {
            await bot.telegram.sendMessage(telegramUserId, "⚠️ Hmm, I couldn't find any clear recurring grocery patterns in your recent orders. I will try again next week.");
        }

    } catch (e) {
        console.error("Background Analysis Error:", e);
        await bot.telegram.sendMessage(telegramUserId, "❌ An error occurred during background analysis. Please check your Swiggy connection or try again later.");
    } finally {
        await swiggy.disconnect();
    }
}

// Help command
bot.command('help', (ctx) => {
    ctx.reply("🤖 **RestockBot Commands:**\n\n- /analyze: Build your grocery consumption profile\n- /login: Connect your Swiggy account\n- /address: Set your delivery address\n- /help: Show this message\n- /debug_reset: (Debug) Force all items to be due today\n- /test_cart: (Debug) Show current cart items\n- /test_clear_cart: (Debug) Empty your Swiggy cart", { parse_mode: 'Markdown' });
});

// Debug: Reset all dates to today
bot.command('debug_reset', async (ctx) => {
    const telegramUserId = ctx.from.id;
    const profile = await getConsumptionSchedule(telegramUserId);
    if (!profile || !profile.schedule) return ctx.reply("❌ No profile found.");

    const today = new Date().toISOString();
    profile.schedule = profile.schedule.map(item => ({
        ...item,
        nextSuggestedOrderAt: today
    }));

    await saveConsumptionSchedule(telegramUserId, profile, { initiator: 'debug_reset' });
    ctx.reply("✅ **Debug Reset!** All items in your profile are now marked as due for restock today.");
});

// Diagnostic: Show cart and address info
bot.command('test_cart', async (ctx) => {
    const telegramUserId = ctx.from.id;
    const token = await getAuthToken(telegramUserId);
    const addressId = await getPreferredAddress(telegramUserId);

    if (!token || !addressId) return ctx.reply("❌ Login and set address first.");

    const swiggy = new SwiggyClient();
    if (!(await swiggy.connect(token))) return ctx.reply("❌ Swiggy connection failed.");

    try {
        const cartResponse = await swiggy.getCart(addressId);
        const cartData = cartResponse.content?.[0]?.text ? JSON.parse(cartResponse.content[0].text) : {};
        const cartItems = cartData.data?.items || [];

        // Fetch addresses to find the matching one for display
        const addrRes = await swiggy.getAddresses();
        const addrText = addrRes.content?.[0]?.text;
        let addrStr = addressId;
        try {
            const addrData = JSON.parse(addrText);
            const allAddrs = addrData.data?.addresses || [];
            const match = allAddrs.find(a => String(a.id) === String(addressId));
            if (match) {
                addrStr = `${match.addressTag || 'Selected'}: ${match.addressLine || match.address_line || ''}`;
            }
        } catch (e) { }

        let msg = `🏠 **Current Address:** \`${addrStr}\` (ID: \`${addressId}\`)\n`;
        msg += `🛒 **Cart Items (${cartItems.length}):**\n\n`;

        if (cartItems.length === 0) {
            msg += "_Your cart is empty._";
        } else {
            cartItems.forEach((item, idx) => {
                const name = item.itemName || item.name || item.item_name || "Unknown Item";
                msg += `${idx + 1}. ${name} (ID: \`${item.spinId || item.spin_id}\`)\n`;
            });
        }

        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply("❌ Failed to fetch cart: " + e.message);
    } finally {
        await swiggy.disconnect();
    }
});

// Diagnostic: Clear the Swiggy cart
bot.command('test_clear_cart', async (ctx) => {
    const telegramUserId = ctx.from.id;
    const token = await getAuthToken(telegramUserId);
    const addressId = await getPreferredAddress(telegramUserId);

    if (!token || !addressId) return ctx.reply("❌ Login and set address first.");

    const swiggy = new SwiggyClient();
    if (!(await swiggy.connect(token))) return ctx.reply("❌ Swiggy connection failed.");

    try {
        console.log(`[DebugClear] Attempting 'clear_cart' for address ${addressId}`);
        await ctx.reply("🗑️ Sending 'clear_cart' command...");

        const res = await swiggy.emptyCart(addressId);
        console.log(`[DebugClear] Result:`, JSON.stringify(res));

        // Verify immediately
        console.log(`[DebugClear] Verifying emptiness at Address: ${addressId}`);
        const verifyRes = await swiggy.getCart(addressId);
        const verifyText = verifyRes.content?.[0]?.text;
        console.log(`[DebugClear] Raw Verify Response:`, verifyText);

        const verifyData = verifyText ? JSON.parse(verifyText) : {};
        const count = verifyData.data?.items?.length || 0;

        if (count === 0) {
            ctx.reply("✅ **Cart Cleared!** Verified via get_cart: Your cart is now empty.");
        } else {
            console.warn(`[DebugClear] Verification failed. Cart still has ${count} items.`);
            ctx.reply(`⚠️ **Clear command sent, but cart still has ${count} items.**\n\nThis confirms the clear_cart tool is not clearing the items for address \`${addressId}\`.`);
        }
    } catch (e) {
        console.error(`[DebugClear] CRASH:`, e.message);
        ctx.reply("❌ Failed to clear cart: " + e.message);
    } finally {
        await swiggy.disconnect();
    }
});

// Helper: Display the schedule to the user
async function displaySchedule(telegramUserId, profile) {
    const schedule = profile.schedule || [];

    if (schedule.length === 0) {
        return bot.telegram.sendMessage(telegramUserId, "📋 Your grocery profile is empty. Try running /analyze to build one.");
    }

    let replyText = "🧠 **Your Grocery Consumption Profile**\n\n";
    if (profile.metadata) {
        const date = new Date(profile.metadata.completedAt).toLocaleDateString();
        replyText += `_Last analyzed: ${date} (via ${profile.metadata.initiator})_\n\n`;
    }

    for (const item of schedule) {
        replyText += `- **${item.itemName}** (Every ${item.frequencyDays} days)\n  _Search:_ ${item.searchQuery}\n  _Next restock:_ ${new Date(item.nextSuggestedOrderAt).toDateString()}\n\n`;
    }

    try {
        await bot.telegram.sendMessage(telegramUserId, replyText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: "🛒 Check Today's Restock", callback_data: "check_restock_today" }]]
            }
        });
    } catch (markdownError) {
        await bot.telegram.sendMessage(telegramUserId, replyText, {
            reply_markup: {
                inline_keyboard: [[{ text: "🛒 Check Today's Restock", callback_data: "check_restock_today" }]]
            }
        });
    }
}

// Command: /analyze (Force an analysis of history)
bot.command('analyze', async (ctx) => {
    const profile = await getConsumptionSchedule(ctx.from.id);

    if (profile && profile.metadata && profile.metadata.completedAt) {
        const lastCompleted = new Date(profile.metadata.completedAt);
        const today = new Date();

        if (lastCompleted.toDateString() === today.toDateString()) {
            return ctx.reply("🧠 **Analysis already exists for today!**\n\nI have already processed your recent orders and built an optimized profile. Re-running analysis too often is expensive and usually not necessary.", {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📊 See Latest Analysis", callback_data: "view_full_analysis" }],
                        [{ text: "🔄 Re-initiate Analysis", callback_data: "run_new_analysis" }]
                    ]
                }
            });
        }
    }

    ctx.reply("🔍 **Analysis Started!** I'm scanning your Swiggy history now. This typically takes about 60-90 seconds...\n\nI'll notify you here as soon as your profile is ready! 🚀", { parse_mode: 'Markdown' });

    // Trigger background analysis without await
    runAnalysis(ctx.from.id);
});

// Callback: View Full Profile
bot.action('view_full_analysis', async (ctx) => {
    await ctx.answerCbQuery();
    const profile = await getConsumptionSchedule(ctx.from.id);
    if (profile) {
        return displaySchedule(ctx.from.id, profile);
    } else {
        return ctx.reply("❌ No analysis found. Try running /analyze.");
    }
});

bot.action('run_new_analysis', async (ctx) => {
    await ctx.answerCbQuery("Starting fresh analysis...");
    await ctx.editMessageText("🔄 **Analysis Started!** I'm fetching your fresh Swiggy history now. I'll notify you here once the results are ready! 🚀", { parse_mode: 'Markdown' });

    // Trigger background analysis without await
    runAnalysis(ctx.from.id);
});

// Callback: Check Today's Restock
bot.action('check_restock_today', async (ctx) => {
    await ctx.answerCbQuery("Checking your cart...");
    const telegramUserId = ctx.from.id;
    const profile = await getConsumptionSchedule(telegramUserId);

    if (!profile || !profile.schedule) {
        return ctx.reply("❌ No grocery profile found. Please run /analyze first.");
    }

    const token = await getAuthToken(telegramUserId);
    if (!token) return ctx.reply("❌ Please /login first.");

    const swiggy = new SwiggyClient();
    if (!(await swiggy.connect(token))) return ctx.reply("❌ Swiggy connection failed.");

    try {
        const addressId = await getPreferredAddress(telegramUserId);
        if (!addressId) return ctx.reply("📍 Please set your /address first.");

        // Fetch current cart to avoid duplicates
        const cartResponse = await swiggy.getCart(addressId);
        const cartData = cartResponse.content?.[0]?.text ? JSON.parse(cartResponse.content[0].text) : {};
        const cartItems = cartData.data?.items || [];
        const cartItemNames = cartItems.map(i => (i.name || i.item_name || "").toLowerCase());

        const today = new Date();
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        const dueItems = profile.schedule.filter(item => {
            if (!item.itemName) return false;

            const nextOrder = new Date(item.nextSuggestedOrderAt);
            const nextOrderStart = new Date(nextOrder.getFullYear(), nextOrder.getMonth(), nextOrder.getDate());

            const isDue = nextOrderStart <= todayStart;

            const alreadyInCart = cartItemNames.some(name => {
                const cleanName = (name || "").trim().toLowerCase();
                if (cleanName.length === 0) return false;

                const itemNameLower = item.itemName.toLowerCase();
                return cleanName.includes(itemNameLower) || itemNameLower.includes(cleanName);
            });

            console.log(`[RestockCheck] Item: ${item.itemName} | isDue: ${isDue} | inCart: ${alreadyInCart}`);
            return isDue && !alreadyInCart;
        });

        if (dueItems.length === 0) {
            return ctx.reply("✅ **Everything looks good!**\n\nBased on your consumption patterns, you don't need any restocks today (or they are already in your cart).", {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: "🛒 View Cart on Swiggy", url: "https://www.swiggy.com/instamart/cart" }]]
                }
            });
        }

        let replyText = "🛒 **Items due for restock today:**\n\n";
        dueItems.forEach(item => {
            replyText += `- **${item.itemName}** (Every ${item.frequencyDays} days)\n`;
        });
        replyText += "\nWould you like me to add these to your Swiggy cart?";

        return ctx.reply(replyText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Add to Cart", callback_data: "add_to_cart_now" }],
                    [{ text: "🛒 View Cart on Swiggy", url: "https://www.swiggy.com/instamart/cart" }]
                ]
            }
        });
    } catch (e) {
        console.error("Check Restock Error:", e);
        ctx.reply("❌ Failed to check restock status. Check logs.");
    } finally {
        await swiggy.disconnect();
    }
});

// Callback: Add to Cart Now
bot.action('add_to_cart_now', async (ctx) => {
    await ctx.answerCbQuery("Adding to Swiggy cart...");
    const telegramUserId = ctx.from.id;
    const profile = await getConsumptionSchedule(telegramUserId);
    const token = await getAuthToken(telegramUserId);
    const addressId = await getPreferredAddress(telegramUserId);

    if (!profile || !token || !addressId) return ctx.reply("❌ Missing information. Try /analyze or /address.");

    const swiggy = new SwiggyClient();
    if (!(await swiggy.connect(token))) return ctx.reply("❌ Swiggy connection failed.");

    try {
        await ctx.editMessageText("🔄 **Adding items to your cart...**", { parse_mode: 'Markdown' });

        const today = new Date();
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        // Fetch current cart again to be safe
        let cartItemSpinIds = [];
        try {
            const cartResponse = await swiggy.getCart(addressId);
            const cartData = cartResponse.content?.[0]?.text ? JSON.parse(cartResponse.content[0].text) : {};
            const cartItems = cartData.data?.items || [];
            cartItemSpinIds = cartItems.map(i => (i.spinId || i.spin_id || i.id));
            console.log(`[AddToCart] Current cart spinIds: ${cartItemSpinIds.join(', ')}`);
        } catch (e) {
            console.error("[AddToCart] Failed to fetch cart for duplicate check:", e);
        }

        const dueItems = profile.schedule.filter(item => {
            if (!item.itemName) return false;
            const nextOrder = new Date(item.nextSuggestedOrderAt);
            const nextOrderStart = new Date(nextOrder.getFullYear(), nextOrder.getMonth(), nextOrder.getDate());

            const isDue = nextOrderStart <= todayStart;
            // Check if item's spinId is already in cart
            const alreadyInCart = item.spinId && cartItemSpinIds.includes(item.spinId);

            console.log(`[AddToCartFilter] Item: ${item.itemName} | isDue: ${isDue} | item.spinId: ${item.spinId} | alreadyInCart: ${alreadyInCart}`);
            return isDue && !alreadyInCart;
        });

        let addressTag = 'Unknown';
        try {
            const addrRes = await swiggy.getAddresses();
            const addrText = addrRes.content?.[0]?.text;
            const addrData = JSON.parse(addrText);
            const allAddrs = addrData.data?.addresses || [];
            const match = allAddrs.find(a => String(a.id) === String(addressId));
            if (match) {
                addressTag = match.addressTag || match.addressCategory || 'Selected';
            }
        } catch (e) {
            console.warn("[AddToCart] Could not fetch address tag for logging:", e.message);
        }

        const tokenPrefix = (typeof token === 'string') ? `${token.substring(0, 10)}...` : '[Object/Invalid]';
        console.log(`[AddToCart] Address: ${addressId} (${addressTag}), Token: ${tokenPrefix}`);
        console.log(`[AddToCart] Due items: ${dueItems.length}, Already in cart: ${cartItemSpinIds.length}`);
        let addedCount = 0;

        // Fetch current cart to merge items (avoid overwriting existing cart)
        let currentCartItems = [];
        try {
            const cartResponse = await swiggy.getCart(addressId);
            const cartData = cartResponse.content?.[0]?.text ? JSON.parse(cartResponse.content[0].text) : {};
            currentCartItems = cartData.data?.items || [];
            console.log(`[AddToCart] Existing items in cart: ${currentCartItems.length}`);
        } catch (e) {
            console.error("[AddToCart] Failed to pre-fetch cart:", e);
        }

        // Map existing items to spinId list
        const updateList = currentCartItems.map(i => ({
            spinId: i.spinId || i.spin_id || i.id,
            quantity: i.quantity || 1
        })).filter(i => i.spinId);

        const successItems = [];
        for (const item of dueItems) {
            console.log(`[AddToCart] Searching for: ${item.itemName}...`);
            const searchResults = await swiggy.searchProducts(item.searchQuery, addressId);
            let spinId = extractFirstSpinId(searchResults);

            if (!spinId && item.fallbackSearchQuery) {
                console.log(`[AddToCart] Trying fallback for ${item.itemName}: "${item.fallbackSearchQuery}"`);
                const fallbackRes = await swiggy.searchProducts(item.fallbackSearchQuery, addressId);
                spinId = extractFirstSpinId(fallbackRes);
            }

            if (spinId) {
                // Add to our update list if not already there
                if (!updateList.some(u => u.spinId === spinId)) {
                    updateList.push({ spinId: spinId, quantity: 1 });
                    successItems.push(item.itemName);

                    // Update schedule locally
                    item.lastOrderedAt = today.toISOString();
                    const nextDate = new Date(today);
                    nextDate.setDate(nextDate.getDate() + item.frequencyDays);
                    item.nextSuggestedOrderAt = nextDate.toISOString();
                }
            } else {
                console.log(`[AddToCart] ❌ Could not find spinId for "${item.itemName}"`);
            }
        }

        if (successItems.length > 0 || updateList.length > 0) {
            console.log(`[AddToCart] STEP 1: Emptying cart for a clean slate...`);
            try {
                await swiggy.emptyCart(addressId);
            } catch (e) {
                console.warn("[AddToCart] Empty cart failed (might be already empty):", e.message);
            }

            console.log(`[AddToCart] STEP 2: Sending batch update for ${updateList.length} total items...`);
            console.log(`[AddToCart] Payload Preview:`, JSON.stringify(updateList.slice(0, 3)));
            const updateRes = await swiggy.updateCartItems(updateList, addressId);
            console.log(`[AddToCart] Batch update Response:`, JSON.stringify(updateRes).substring(0, 500));
            addedCount = successItems.length;
        }

        // --- VERIFICATION STEP ---
        console.log(`[AddToCart] Verifying additions. Fetching cart...`);
        let finalCartCount = 0;
        try {
            const verifyResponse = await swiggy.getCart(addressId);
            const verifyText = verifyResponse.content?.[0]?.text;
            if (verifyText) {
                const verifyData = JSON.parse(verifyText);
                const finalItems = verifyData.data?.items || [];
                finalCartCount = finalItems.length;
                console.log(`[AddToCart] VERIFIED: Cart now has ${finalCartCount} items.`);
                console.log(`[AddToCart] Raw Cart Items JSON:`, JSON.stringify(finalItems));
            }
        } catch (verErr) {
            console.error("[AddToCart] Verification failed:", verErr.message);
        }

        if (addedCount > 0) {
            await saveConsumptionSchedule(telegramUserId, profile, { initiator: 'user_action' });
            await ctx.reply(`✅ **Successfully added ${addedCount} items to your cart!**\n\nYou can now review and checkout in the Swiggy app.`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: "🛒 View Cart on Swiggy", url: "https://www.swiggy.com/instamart/cart" }]]
                }
            });
        } else {
            await ctx.reply("⚠️ I couldn't find matches for the items due today. Please try searching for them manually in the Swiggy app.");
        }
    } catch (e) {
        console.error("Add to Cart Error:", e);
        ctx.reply("❌ Failed to complete cart update.");
    } finally {
        await swiggy.disconnect();
    }
});

// Helper for spinId extraction from raw search response
function extractFirstSpinId(searchResults) {
    try {
        // 1. Try proper JSON parsing first (most robust)
        const text = searchResults.content?.[0]?.text;
        if (text) {
            const data = JSON.parse(text);
            const firstProduct = data.data?.products?.[0];
            const firstVariation = firstProduct?.variations?.[0];
            if (firstVariation?.spinId) {
                return firstVariation.spinId;
            }
        }

        // 2. Regex fallback (handles cases where structure might slightly differ but spinId exists)
        const rawString = typeof searchResults === 'string' ? searchResults : JSON.stringify(searchResults);
        // Match both plain and escaped quotes
        const spinIdMatch = rawString.match(/\\?"spinId\\?"\s*:\s*\\?"([^\\"]+)\\?"/);
        return spinIdMatch ? spinIdMatch[1] : null;

    } catch (e) {
        console.error("[SpinIdCheck] Error:", e);
        return null;
    }
}

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

        const buttons = addresses.map(addr => {
            const tag = (addr.addressTag || addr.addressCategory || '📍').toUpperCase();
            const line = addr.addressLine || addr.address_line || addr.addressLine1 || '';
            const area = addr.area || addr.landmark || '';
            const label = `${tag}: ${line.substring(0, 30)}${area ? ' (' + area + ')' : ''}`;

            return [{
                text: label,
                callback_data: `sel_addr:${addr.id}`
            }];
        });

        ctx.reply("🎯 Please select the **exact address** that matches your active Swiggy App location:", {
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
                const startTime = Date.now();
                const response = await handleUserQuery(swiggy, text, addressId); // Assuming handleUserQuery internally uses LLM and this is where timing is desired
                const duration = (Date.now() - startTime) / 1000;
                console.log(`[Query] handleUserQuery took ${duration.toFixed(2)}s`);

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

// Global Error Handler for the bot
bot.catch((err, ctx) => {
    console.error(`[Bot] Error for update ${ctx.update.update_id}:`, err);
    ctx.reply("⚠️ Oops! Something went wrong while processing your request. Please try again later.");
});

export default bot;
