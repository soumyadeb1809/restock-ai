process.env.TZ = 'Asia/Kolkata';
import { SwiggyClient } from './mcp_client.js';
import { getAuthToken, getConsumptionSchedule, getPreferredAddress } from './db.js';
import bot from './bot.js';

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

        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

        for (const item of itemsToOrder) {
            // 1. Search for the item using preferred brand querying
            console.log(`[Cron] Searching Swiggy for: ${item.searchQuery}`);
            let searchResults = await swiggy.searchProducts(item.searchQuery, addressId);
            let foundSpinId = extractFirstSpinId(searchResults);

            // Fallback 1: Fallback Search Query
            if (!foundSpinId && item.fallbackSearchQuery) {
                await delay(500); // Small interval padding for fallbacks
                console.log(`[Cron] Preferred brand not found. Using fallback: ${item.fallbackSearchQuery}`);
                searchResults = await swiggy.searchProducts(item.fallbackSearchQuery, addressId);
                foundSpinId = extractFirstSpinId(searchResults);
            }

            // Fallback 2: Generic Alternatives (Add to Cart Support)
            let isAlternative = false;
            let altDisplayName = "";

            if (!foundSpinId && item.genericSearchQuery) {
                await delay(500); // Small interval padding for alternatives queries
                console.log(`[Cron] Searching generic alternatives for ${item.itemName}: ${item.genericSearchQuery}`);
                try {
                    const genericResults = await swiggy.searchProducts(item.genericSearchQuery, addressId);
                    foundSpinId = extractFirstSpinId(genericResults);
                    if (foundSpinId) {
                        isAlternative = true;
                        const altNames = extractAlternativeNames(genericResults);
                        altDisplayName = altNames[0] || "Alternative";
                    } else {
                        // Store full list for notification failures IF it still fails
                        const alternatives = extractAlternativeNames(genericResults);
                        if (alternatives.length > 0) {
                            alternativeSuggestions[item.itemName] = alternatives;
                        }
                    }
                } catch (gErr) {
                    console.warn(`[Cron] Generic search failed for ${item.itemName}:`, gErr.message);
                }
            }

            if (foundSpinId) {
                const orderQuantity = item.quantity || 1;
                // 2. Add to Cart
                await swiggy.updateCart(foundSpinId, orderQuantity, addressId);
                console.log(`[Cron] Successfully added ${item.itemName} (Alt: ${isAlternative}) to cart (SpinId: ${foundSpinId})`);

                let displayName = orderQuantity > 1 ? `${item.itemName} (x${orderQuantity})` : item.itemName;
                if (isAlternative) {
                    displayName += ` (Alternative: ${altDisplayName})`;
                }
                addedItemsList.push(displayName);
            } else {
                console.log(`[Cron] Could not find any match for ${item.itemName} (even with generic).`);
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
                        inline_keyboard: [[{ text: "Go to Checkout", url: cartLink }]]
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

function extractFirstSpinId(searchResults) {
    try {
        const rawString = typeof searchResults === 'string' ? searchResults : JSON.stringify(searchResults);
        const spinIdMatch = rawString.match(/"spinId"\s*:\s*"([^"]+)"/);
        return spinIdMatch ? spinIdMatch[1] : null;
    } catch (e) {
        return null;
    }
}

function extractAlternativeNames(searchResults) {
    try {
        const text = searchResults.content?.[0]?.text;
        if (!text) return [];
        const parsed = JSON.parse(text);
        const products = parsed.data?.products || [];
        // Extract top 3 names
        return products.slice(0, 3).map(p => p.displayName || p.name).filter(Boolean);
    } catch (e) {
        return [];
    }
}
