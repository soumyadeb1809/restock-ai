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
1. **Cross-Reference Lists**: The 'DETAILED ORDERS' list contains basic item names. The 'GO TO ITEMS' list contains richer metadata with detailed \`variations\` and \`quantityDescription\` (e.g., "300 ml x 6"). If an item appears in both lists, **strictly use the pack size/descriptions from the 'GO TO ITEMS' list** to model your suggested order variant.
2. **Include Variant Specs**: Primary \`searchQuery\` must be extremely specific. Include weights/volumes (e.g., "300 ml x 6 packs", "500 g").
3. **Determine Set Quantity**: Set the \`quantity\` field for the number of typical *packs* to trigger at once. **If you are uncertain about the correct pack size, ALWAYS default to the lowest available quantity or pack size to prevent over-ordering.**
4. Provide a reputable \`fallbackSearchQuery\` of the **exact same variant/pack size** where possible.
5. **Generic Alternative Search**: Provide a loose, brandless lookup term (e.g., "Whole Wheat Bread", "Cooking Oil") in \`genericSearchQuery\`. This will be used to look up restock substitutes if your primary listings are fully out of stock.

You must reply with ONLY a valid JSON object matching this schema:
{
  "schedule": [
    {
      "itemName": "String",
      "searchQuery": "String",
      "fallbackSearchQuery": "String",
      "genericSearchQuery": "String",
      "quantity": Number,
      "frequencyDays": Number,
      "confidence": Number (1-100),
      "lastOrderedAt": "ISO Date String",
      "nextSuggestedOrderAt": "ISO Date String"
    }
  ]
}

**STRICT CATEGORY FILTERING & ANTI-DRIFT RULES:**
1. **Include ONLY**: Kitchen consumables, Cooking staples (Vegetables, Fruits, Milk, Eggs, Bread, Spices, Oil, Pulses, Meat), and Essential Household utility/consumables (Detergent, Fabric softener, Toilet paper, Floor cleaners).
2. **Exclude ABSOLUTELY**: Flowers/Gifts, non-consumable electronics, medicines, apparel, and ornamental items. (Example: If a user ordered "Roses" or "Ganesh Idol", exclude it completely).
3. **No One-Offs**: For an item to earn a slot in the schedule, there must be evidence of recurring consumption OR high-probability consumable intent over multiple cycles. Never include items purchased only once unless you can confidently infer a cyclic kitchen schedule requirement (e.g. Salt).

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
        console.log(`[Analyze] Triggering LLM (${process.env.LLM_PROVIDER || 'gemini'}) to analyze order dimensions & rules...`);
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

