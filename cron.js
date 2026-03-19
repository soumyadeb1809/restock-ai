process.env.TZ = 'Asia/Kolkata';
import { SwiggyClient } from './mcp_client.js';
import { getAuthToken, getConsumptionSchedule, getPreferredAddress, saveAuthToken } from './db.js';
import { resolveItemsWithSearchResults } from './pattern_engine.js';
import bot from './bot.js';

const parseProducts = (res) => {
    try {
        const text = res.content?.[0]?.text;
        if (!text) return [];
        const parsed = JSON.parse(text);
        return parsed.data?.products || [];
    } catch { return []; }
};

export async function checkAndOrder(telegramUserId) {
    console.log(`[Cron] Running daily check for user ${telegramUserId}...`);

    const today = new Date();

    // --- PROACTIVE TOKEN EXPIRATION CHECK ---
    try {
        const token = await getAuthToken(telegramUserId);
        const accessToken = token && (typeof token === 'string' ? token : token.access_token);

        if (accessToken) {
            const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
            if (payload && payload.exp) {
                const expirationTimeMs = payload.exp * 1000;
                const oneDayInMs = 24 * 60 * 60 * 1000;
                const isExpiringSoon = (expirationTimeMs - today.getTime()) < oneDayInMs;

                if (isExpiringSoon) {
                    const hoursLeft = Math.round((expirationTimeMs - today.getTime()) / (1000 * 60 * 60));
                    console.log(`[Cron] Token for ${telegramUserId} is expiring soon (${hoursLeft}h left). Notifying user...`);
                    bot.telegram.sendMessage(telegramUserId, `⚠️ <b>Swiggy Session Alert</b>\n\nYour Swiggy login session will expire in approximately ${hoursLeft} hours. Please use /login soon to keep your daily restock alerts running smoothly!`, { parse_mode: 'HTML' });
                }
            }
        }
    } catch (err) {
        console.warn("[Cron] Failed to verify token expiration date during proactive check:", err.message);
    }
    // ----------------------------------------

    // --- 1. RUN ANALYSIS FIRST ---
    console.log(`[Cron] Triggering automatic schedule update and history analysis for ${telegramUserId}...`);
    try {
        const botModule = await import('./bot.js');
        // Await the analysis so fully updated rules are in Firestore
        await botModule.runAnalysis(telegramUserId, 'cron');
        console.log(`[Cron] Analysis complete. Proceeding with restock check.`);
    } catch (err) {
        console.error("[Cron] Failed to run preemptive analysis:", err);
        // We continue anyway so we don't completely skip restocking if the AI fails
    }
    // ------------------------------

    const scheduleObj = await getConsumptionSchedule(telegramUserId);
    if (!scheduleObj || !scheduleObj.schedule) {
        console.log(`[Cron] No schedule found for user ${telegramUserId}.`);
        return;
    }

    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const itemsToOrder = scheduleObj.schedule.filter(item => {
        if (!item.itemName) return false;

        const nextOrder = new Date(item.nextSuggestedOrderAt);
        const nextOrderStart = new Date(nextOrder.getFullYear(), nextOrder.getMonth(), nextOrder.getDate());

        // Is the next order date today or in the past?
        return nextOrderStart <= todayStart;
    });

    if (itemsToOrder.length === 0) {
        console.log(`[Cron] No items need restocking today for user ${telegramUserId}.`);
        bot.telegram.sendMessage(telegramUserId, "✅ <b>Restock Check Complete</b>\n\nNo items are due for restock today! Your consumption schedule looks fully up to date.", { parse_mode: 'HTML' });
        return;
    }

    console.log(`[Cron] Found ${itemsToOrder.length} items due for restock today: ${itemsToOrder.map(i => i.itemName).join(', ')}`);

    const token = await getAuthToken(telegramUserId);
    if (!token) {
        bot.telegram.sendMessage(telegramUserId, "⚠️ I tried to restock your groceries, but your Swiggy session expired. Please type /login to reconnect.");
        return;
    }

    const swiggy = new SwiggyClient();
    const connected = await swiggy.connect(token);

    if (!connected) {
        bot.telegram.sendMessage(telegramUserId, "⚠️ I tried to restock your groceries, but Swiggy rejected the connection. You might need to /login again.");
        return;
    }

    // Save newly refreshed token if SwiggyClient automatically updated it during connection
    if (swiggy.refreshedToken) {
        console.log(`[Cron] Saving refreshed token for user ${telegramUserId}...`);
        await saveAuthToken(telegramUserId, swiggy.refreshedToken);
    }

    try {
        let addedItemsList = [];
        const alternativeSuggestions = {}; // Map of { itemName: [alt1, alt2] }
        const addressId = await getPreferredAddress(telegramUserId);

        if (!addressId) {
            console.warn(`[Cron] No preferred address found for user ${telegramUserId}. Skipping restock.`);
            bot.telegram.sendMessage(telegramUserId, "⚠️ I tried to check your restock list, but I don't know which address to use! Please type /address to select a delivery location.");
            return;
        }
        const bundles = [];
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

        for (const item of itemsToOrder) {
            console.log(`[Cron] Aggregating searches for: ${item.itemName}`);
            const pool = [];

            try {
                const res = await swiggy.searchProducts(item.searchQuery, addressId);
                pool.push(...parseProducts(res));
            } catch (e) {
                console.warn(`[Cron] Preferred search failed for ${item.itemName}:`, e.message);
            }

            if (item.fallbackSearchQuery) {
                await delay(500);
                try {
                    const res = await swiggy.searchProducts(item.fallbackSearchQuery, addressId);
                    pool.push(...parseProducts(res));
                } catch (e) { }
            }

            if (item.genericSearchQuery) {
                await delay(500);
                try {
                    const res = await swiggy.searchProducts(item.genericSearchQuery, addressId);
                    pool.push(...parseProducts(res));
                } catch (e) { }
            }

            bundles.push({
                itemName: item.itemName,
                searchResults: pool
            });
        }

        if (bundles.length > 0) {
            const decision = await resolveItemsWithSearchResults(bundles);

            for (const res of decision.results || []) {
                if (res.spinId) {
                    const originalItem = itemsToOrder.find(i => i.itemName === res.itemName);
                    const qty = originalItem?.quantity || 1;

                    try {
                        await swiggy.updateCart(res.spinId, qty, addressId);
                        console.log(`[Cron] Added ${res.itemName} to cart (spinId: ${res.spinId})`);
                        addedItemsList.push(`${res.itemName} (${res.resolvedName || "Matched"})`);
                    } catch (cartErr) {
                        console.error(`[Cron] Failed to add ${res.itemName} to cart:`, cartErr.message);
                    }
                } else {
                    console.log(`[Cron] LLM could not resolve item ${res.itemName}. Reason: ${res.reason || "None"}`);
                    const originalBundle = bundles.find(b => b.itemName === res.itemName);
                    if (originalBundle && originalBundle.searchResults) {
                        // Extract top 3 product names from the pool for suggestion readout
                        alternativeSuggestions[res.itemName] = originalBundle.searchResults.slice(0, 3).map(p => p.displayName || p.name).filter(Boolean);
                    }
                }
            }
        }

        // Notify the user
        if (addedItemsList.length > 0) {
            console.log(`[Cron] Batch Cart Update Complete. Added ${addedItemsList.length} items: ${addedItemsList.join(', ')}`);
            // Alternative suggestions text (HTML)
            let altsHTML = "";
            const altKeys = Object.keys(alternativeSuggestions);
            if (altKeys.length > 0) {
                altsHTML = "\n\n💡 <b>Alternatives Available (Out of stock items):</b>\n";
                for (const name of altKeys) {
                    altsHTML += `\n• <b>${name}</b>:\n` + alternativeSuggestions[name].map(a => `  - ${a}`).join('\n') + "\n";
                }
            }

            // Deep link directly to the Instamart cart
            const cartLink = "https://www.swiggy.com/instamart/cart";

            bot.telegram.sendMessage(
                telegramUserId,
                "🛒 <b>Restock Alert!</b>\n\n" +
                "I've automatically added these to your Swiggy Instamart cart:\n\n" +
                addedItemsList.map(item => `• ${item}`).join('\n') +
                altsHTML +
                "\n\nClick below to review your cart and checkout safely.",
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: "🛒 View Cart on Swiggy", url: cartLink }]]
                    }
                }
            );
        } else {
            // All due items failed to match (likely out of stock)
            console.log(`[Cron] All due items failed to resolve to a spinId for user ${telegramUserId}.`);

            // Alternative suggestions text (HTML)
            let altsHTML = "";
            const altKeys = Object.keys(alternativeSuggestions);
            if (altKeys.length > 0) {
                altsHTML = "\n\n💡 <b>Alternatives Available:</b>\n";
                for (const name of altKeys) {
                    altsHTML += `\n• <b>${name}</b>:\n` + alternativeSuggestions[name].map(a => `  - ${a}`).join('\n') + "\n";
                }
            }

            bot.telegram.sendMessage(
                telegramUserId,
                "⚠️ <b>Restock Notification</b>\n\n" +
                "I checked your consumption schedule, and some items are due for restock today, but they appear to be **out of stock** (or not found) on Swiggy Instamart right now.\n\n" +
                "I wasn't able to add anything to your cart automatically." +
                altsHTML +
                "\n\nPlease check the Swiggy app manually to look for other options.",
                { parse_mode: 'HTML' }
            );
        }

    } catch (e) {
        console.error("[Cron] Error during auto-order:", e);
        bot.telegram.sendMessage(telegramUserId, "⚠️ I tried to add your restock items to the cart, but encountered an error. Please check your Swiggy app manually.");
    } finally {
        await swiggy.disconnect();
    }
}
