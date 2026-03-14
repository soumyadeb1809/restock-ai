import { SwiggyClient } from './mcp_client.js';
import { getAuthToken } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

async function listTools() {
    const telegramUserId = process.env.TELEGRAM_ALLOWED_USER_ID;
    const token = await getAuthToken(telegramUserId);
    const swiggy = new SwiggyClient();
    if (!await swiggy.connect(token)) return;

    try {
        const tools = await swiggy.client.listTools();
        ['get_cart', 'clear_cart', 'update_cart'].forEach(name => {
            const tool = tools.tools.find(t => t.name === name);
            if (tool) {
                console.log(`TOOL: ${tool.name}`);
                console.log(`DESCRIPTION: ${tool.description}`);
                console.log(`SCHEMA: ${JSON.stringify(tool.inputSchema, null, 2)}`);
                console.log('---');
            }
        });
    } finally {
        await swiggy.disconnect();
    }
}

listTools();
