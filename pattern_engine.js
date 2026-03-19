import { LLMProvider } from './llm_provider.js';
import dotenv from 'dotenv';
dotenv.config();

const llm = new LLMProvider();

/**
 * Analyzes Swiggy Instamart order data to determine grocery consumption patterns.
 * Now supports injecting previous schedules to maintain consistency.
 * 
 * @param {Array} detailedOrders - Raw JSON array of full order details
 * @param {Array} gotoItems - (Optional) Aggregated frequent items
 * @param {Array} previousSchedule - (Optional) The existing schedule to preserve consistency
 * @returns {Object} JSON schedule object with item predictions
 */
export async function analyzeOrderHistory(detailedOrders, gotoItems = [], previousSchedule = []) {
    const hasOrders = detailedOrders && detailedOrders.length > 0;
    const hasGoto = gotoItems && gotoItems.length > 0;

    if (!hasOrders && !hasGoto) {
        return null;
    }

    const systemPrompt = `
You are an intelligent grocery restocking assistant. I will provide you with data from my Swiggy Instamart account.
This data includes:
1. A JSON array of my "Detailed Orders" (past order history).
2. A list of my "Go To Items" (frequently ordered recently or in the past).
3. **[CRITICAL]** My "Previous Schedule": This contains items that are ALREADY part of my restock routine.

Your goal is to analyze these to determine recurring items (like milk, eggs, bread, coffee) and calculate when I will likely need them next.

**Consistency is highly important**:
- **Do NOT omit items** that already exist in the \`Previous Schedule\` unless the detailed orders explicitly show I have stopped buying them entirely.
- For items that are already in the \`Previous Schedule\`, maintain their \`frequencyDays\` and schedule guidelines **unless new order increments strongly suggest a correction**.
- If a item in the \`Previous Schedule\` has a \`nextSuggestedOrderAt\` set in the future, preserve that timestamp to ensure we don't accidentally duplicate orders or reset the calendar increment prematurely.
- Add **NEW** items to the schedule if the latest order history reveals a recurring consumption pattern that is missing from the Previous Schedule.

**ANALYSIS LOGIC:**
- Use the order history timestamps to calculate accurate frequency (frequencyDays). Do not limit yourself to a specific time window; analyze the entire provided history.
- Calculate the average gap between orders for the same item to determine \`frequencyDays\`.
- If only "Go To Items" are present, infer reasonable frequencies based on the item type (e.g., Milk: 3 days, Bread: 4 days, Coffee: 15 days).

**CRITICAL BRAND & VARIANT INSTRUCTION:** 
Pay close attention to the specific brands, **Exact Variants, Pack Sizes, and Weights/Volumes** of the items in the order history.
When generating the \`searchQuery\` and \`fallbackSearchQuery\`, you must:
1. **Include Variant Specs**: Primary \`searchQuery\` must be extremely specific. If the user buys "Licious Eggs 6 pcs", do NOT just search "Licious Eggs". Include the pack size (e.g., "Licious Rich Eggs 6 pcs").
2. **Determine Set Quantity**: Calculate how many units/packs are typically ordered in a single shipment (e.g., 1 pack, 2 bottles). Set the \`quantity\` field accordingly for a single restock cycle.
3. Provide a \`fallbackSearchQuery\` for a reputable alternate brand of the **exact same variant/pack size** where possible.

You must reply with ONLY a valid JSON object matching this schema:
{
  "schedule": [
    {
      "itemName": "String",
      "searchQuery": "String",
      "fallbackSearchQuery": "String",
      "quantity": Number,
      "frequencyDays": Number,
      "confidence": Number (1-100),
      "lastOrderedAt": "ISO Date String",
      "nextSuggestedOrderAt": "ISO Date String"
    }
  ]
}

Focus strictly on household staples and regular grocery items. 
Always output raw JSON. Do not include markdown formatting.
`;

    try {
        const userPrompt = `
CURRENT DATE: ${new Date().toISOString()}

DETAILED ORDERS (Full fetched history):
${JSON.stringify(detailedOrders)}

GO TO ITEMS (Aggregated history):
${JSON.stringify(gotoItems)}

PREVIOUS SCHEDULE (Preserve these rules/frequencies unless explicitly deprecated):
${JSON.stringify(previousSchedule)}
`;
        const response = await llm.generateText(systemPrompt, userPrompt);

        if (!response) {
            console.warn("[Analyze] LLM returned empty response.");
            return null;
        }

        // Attempt to extract JSON from the response string
        let jsonStr = response.trim();

        // Find the first '{' and the last '}' to isolate the JSON object
        const startIdx = jsonStr.indexOf('{');
        const endIdx = jsonStr.lastIndexOf('}');

        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            jsonStr = jsonStr.substring(startIdx, endIdx + 1);
        }

        try {
            const result = JSON.parse(jsonStr.trim());
            return result;
        } catch (parseErr) {
            console.error("[Analyze] Failed to parse LLM JSON:", parseErr.message);
            console.log("[Analyze] Raw Response:", response);
            return null;
        }
    } catch (error) {
        console.error("[Analyze] Unexpected error in analyzeOrderHistory:", error);
        return null;
    }
}

