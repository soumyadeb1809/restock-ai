import { LLMProvider } from './llm_provider.js';
import dotenv from 'dotenv';

dotenv.config();

const llm = new LLMProvider();

/**
 * Handles general natural language queries using a generic LLM orchestrator for Swiggy tools.
 */
export async function handleUserQuery(swiggy, userQuery, addressId = null) {
    // Define the tools available to the LLM based on our SwiggyClient
    // Input schemas follow the standard JSON schema format compatible with both vendors
    const tools = [
        {
            name: "get_orders",
            description: "Fetches a simplified list of the user's past Swiggy Instamart orders. Useful for seeing 'what I ordered'.",
            input_schema: {
                type: "object",
                properties: {
                    count: { type: "number", description: "Number of orders to fetch (default: 10)" }
                }
            }
        },
        {
            name: "search_products",
            description: "Searches the live Swiggy Instamart catalog for products, brands, and prices.",
            input_schema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "The item name to search for (e.g., 'eggs', 'milk', 'bread')" }
                },
                required: ["query"]
            }
        },
        {
            name: "get_cart",
            description: "Shows what items are currently in the user's Swiggy Instamart cart.",
            input_schema: { type: "object", properties: {} }
        },
        {
            name: "get_addresses",
            description: "Fetches the user's saved addresses. Use this if the user asks about their delivery locations.",
            input_schema: { type: "object", properties: {} }
        },
        {
            name: "update_cart",
            description: "Adds or updates an item in the user's Swiggy Instamart cart. Use this when the user asks to 'add' something.",
            input_schema: {
                type: "object",
                properties: {
                    spinId: { type: "string", description: "The Swiggy spinId (variant ID) to add" },
                    quantity: { type: "number", description: "The quantity to set (default: 1)" }
                },
                required: ["spinId"]
            }
        }
    ];

    const systemPrompt = `You are RestockBot, the user's personal Swiggy Instamart assistant.
    Your goal is to answer questions about their order history, search for products, and manage their cart.
    
    GUIDELINES:
    - Use clear, friendly, and concise language.
    - If a user asks 'what are my past orders', first call get_orders.
    - If they search for something, use search_products.
    - If they want to add an item to their cart, use update_cart. You need a 'spinId' which you MUST get from the variations list in the search results.
    - If a product has multiple variations (different sizes/prices), ALWAYS ask the user to pick one first if they weren't specific.
    - If the tool result is too large, summarize it for the user. Focus on item names and prices.
    - Keep formatting simple. Use basic bold (**text**) and lists (* item).
    - IMPORTANT: Avoid using characters like '>', '(', ')', '#', and '_' unless they are part of a name, as they can break Telegram's Markdown parsing.
    - Never call a checkout or payment tool. You only browse, search, and add items to the cart.
    - If a tool fails with 'addressId is required', it means the user hasn't selected an address yet. Just tell them they need to select a delivery address first.`;

    const messages = [
        { role: "user", content: userQuery }
    ];

    // Tool Handlers map the LLM's tool call back to our SwiggyClient methods
    const handlers = {
        'get_orders': async (input) => {
            const res = await swiggy.getOrders(input.count || 10);
            return res.content?.[0]?.text || res;
        },
        'search_products': async (input) => {
            const res = await swiggy.searchProducts(input.query, addressId);
            return res.content?.[0]?.text || res;
        },
        'get_cart': async () => {
            const res = await swiggy.getCart(addressId);
            return res.content?.[0]?.text || res;
        },
        'get_addresses': async () => {
            const res = await swiggy.getAddresses();
            return res.content?.[0]?.text || res;
        },
        'update_cart': async (input) => {
            const res = await swiggy.updateCart(input.spinId, input.quantity || 1, addressId);
            return res.content?.[0]?.text || res;
        }
    };

    try {
        const responseText = await llm.chatWithTools(systemPrompt, messages, tools, handlers);
        return responseText;
    } catch (e) {
        console.error("Agent Brain Processing Error:", e);
        return "❌ I encountered an error while processing your request. Please try again in a moment.";
    }
}
