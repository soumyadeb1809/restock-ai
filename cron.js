import { SwiggyClient } from './mcp_client.js';
import { getAuthToken, getConsumptionSchedule } from './db.js';
import bot from './bot.js';

export async function checkAndOrder(telegramUserId) {
    console.log(`[Cron] Running daily check for user ${telegramUserId}...`);

    const scheduleObj = await getConsumptionSchedule(telegramUserId);
    if (!scheduleObj || !scheduleObj.schedule) {
        console.log(`[Cron] No schedule found for user ${telegramUserId}.`);
        return;
    }

    const today = new Date();
    const itemsToOrder = scheduleObj.schedule.filter(item => {
        const nextOrderDate = new Date(item.nextSuggestedOrderAt);
        // Is the next order date today or in the past?
        return nextOrderDate <= today;
    });

    if (itemsToOrder.length === 0) {
        console.log(`[Cron] No items need restocking today for user ${telegramUserId}.`);
        return;
    }

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

    try {
        let addedItemsList = [];
        for (const item of itemsToOrder) {
            // 1. Search for the item using preferred brand querying
            console.log(`[Cron] Searching Swiggy for: ${item.searchQuery}`);
            let searchResults = await swiggy.searchProducts(item.searchQuery);
            let foundItemId = extractFirstItemId(searchResults);

            // Fallback if preferred brand is out of stock or not found
            if (!foundItemId && item.fallbackSearchQuery) {
                console.log(`[Cron] Preferred brand not found. Using fallback: ${item.fallbackSearchQuery}`);
                searchResults = await swiggy.searchProducts(item.fallbackSearchQuery);
                foundItemId = extractFirstItemId(searchResults);
            }

            if (foundItemId) {
                // 2. Add to Cart
                await swiggy.updateCart(foundItemId, 1);
                addedItemsList.push(item.itemName);

                // 3. Update schedule manually
                item.lastOrderedAt = today.toISOString();
                const nextDate = new Date(today);
                nextDate.setDate(nextDate.getDate() + item.frequencyDays);
                item.nextSuggestedOrderAt = nextDate.toISOString();
            } else {
                console.log(`[Cron] Could not find any match for ${item.itemName} (even with fallback).`);
            }
        }

        // Notify the user
        if (addedItemsList.length > 0) {
            // Save updated schedule back to DB
            import('./db.js').then(db => db.saveConsumptionSchedule(telegramUserId, scheduleObj));

            // Deep link directly to the Instamart cart
            const cartLink = "https://www.swiggy.com/instamart/cart";

            bot.telegram.sendMessage(
                telegramUserId,
                "🛒 **Restock Alert!**\n\n" +
                "I noticed you're probably running low on some essentials. I've automatically added these to your Swiggy Instamart cart:\n\n" +
                addedItemsList.map(item => `- ${item}`).join('\n') +
                "\n\nClick below to review your cart and checkout safely.",
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: "Go to Checkout", url: cartLink }]]
                    }
                }
            );
        }

    } catch (e) {
        console.error("[Cron] Error during auto-order:", e);
        bot.telegram.sendMessage(telegramUserId, "⚠️ I tried to add your restock items to the cart, but encountered an error. Please check your Swiggy app manually.");
    } finally {
        await swiggy.disconnect();
    }
}

function extractFirstItemId(searchResults) {
    // This function requires parsing the specific JSON structure returned by Swiggy's 'search_products' tool.
    // For this boilerplate, we'll try to find any recognizable ID string.
    try {
        const rawString = typeof searchResults === 'string' ? searchResults : JSON.stringify(searchResults);
        // This is a naive regex. In reality, you'd parse the structured JSON from the Swiggy Tool return.
        const idMatch = rawString.match(/"item_id"\s*:\s*"([^"]+)"/);
        return idMatch ? idMatch[1] : null; // Return null if not found to prevent breaking
    } catch (e) {
        return null;
    }
}
