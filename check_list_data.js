import { SwiggyClient } from './mcp_client.js';
import { getAuthToken } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
    const userId = process.env.TELEGRAM_ALLOWED_USER_ID;
    const token = await getAuthToken(userId);
    const swiggy = new SwiggyClient();
    await swiggy.connect(token);

    try {
        console.log("--- Fetching Orders List ---");
        const res = await swiggy.getOrders(1);
        const text = res.content?.[0]?.text;
        const data = JSON.parse(text || "{}");
        console.log("Order List Response Structure:", JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Error:", e);
    } finally {
        await swiggy.disconnect();
    }
}

test();
