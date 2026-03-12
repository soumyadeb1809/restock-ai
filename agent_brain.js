import { LLMProvider } from './llm_provider.js';
import dotenv from 'dotenv';

dotenv.config();

const llm = new LLMProvider();

/**
 * Handles general natural language queries using a generic LLM orchestrator for Swiggy tools.
 */
export async function handleUserQuery(swiggy, userQuery) {
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
            name: "get_order_details",
            description: "Fetches full details for a specific order ID, including item names, quantities, and prices.",
            input_schema: {
                type: "object",
                properties: {
                    orderId: { type: "string", description: "The order ID to lookup" }
                },
                required: ["orderId"]
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
        }
    ];

    const systemPrompt = `You are RestockBot, the user's personal Swiggy Instamart assistant.
    Your goal is to answer questions about their order history, search for products, and check their cart.
    
    GUIDELINES:
    - Use clear, friendly, and concise language.
    - If a user asks 'what are my past orders', first call get_orders.
    - If they ask for details about a specific recent order, call get_order_details.
    - If they search for something, use search_products.
    - If the tool result is too large, summarize it for the user. Focus on item names and dates.
    - Never place an order or call checkout. You only browse and search.`;

    const messages = [
        { role: "user", content: userQuery }
    ];

    // Tool Handlers map the LLM's tool call back to our SwiggyClient methods
    const handlers = {
        'get_orders': async (input) => {
            const res = await swiggy.getOrders(input.count || 10);
            return res.content?.[0]?.text || res;
        },
        'get_order_details': async (input) => {
            const res = await swiggy.getOrderDetails(input.orderId);
            return res.content?.[0]?.text || res;
        },
        'search_products': async (input) => {
            const res = await swiggy.searchProducts(input.query);
            return res.content?.[0]?.text || res;
        },
        'get_cart': async () => {
            const res = await swiggy.getCart();
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
