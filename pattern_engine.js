import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Analyzes Swiggy Instamart JSON order history to determine grocery consumption patterns.
 * 
 * @param {Array} detailedOrders - Raw JSON array of full order details
 * @returns {Object} JSON schedule object with item predictions
 */
export async function analyzeOrderHistory(detailedOrders) {
    if (!detailedOrders || detailedOrders.length === 0) {
        return null; // Initial state or no data
    }

    const systemPrompt = `
You are an intelligent grocery restocking assistant. I will provide you with a raw JSON array representing my past Swiggy Instamart detailed orders.
Your goal is to analyze the frequency at which I order specific recurring items (like milk, eggs, bread, coffee) and calculate when I will likely need them next.

**CRITICAL BRAND INSTRUCTION:** 
Pay close attention to the specific brands of the items I order. 
When generating the \`searchQuery\` and the new \`fallbackSearchQuery\`, you must:
1. Make the primary \`searchQuery\` specific to the exact brand I usually buy (e.g., "Amul Taaza Milk 500ml").
2. Provide a \`fallbackSearchQuery\` that suggests an alternate reputable brand for that exact item, ONLY to be used if my preferred brand is not available (e.g., "Mother Dairy Milk 500ml"). If no clear fallback exists, make it generic (e.g., "Toned Milk 500ml").

You must reply with ONLY a valid JSON object matching this schema:
{
  "schedule": [
    {
      "itemName": "String (e.g., 'Amul Taaza Milk')",
      "searchQuery": "String (e.g., 'Amul Taaza Milk 500ml') to use in Swiggy product search",
      "fallbackSearchQuery": "String (e.g., 'Mother Dairy Milk 500ml')",
      "frequencyDays": Number (e.g., 3),
      "confidence": Number (1-100),
      "lastOrderedAt": "ISO Date String",
      "nextSuggestedOrderAt": "ISO Date String"
    }
  ]
}

Skip items that were only ordered once or seem like one-off impulse buys (e.g., ice cream, a specific brand of chips that I only bought once). Focus strictly on household staples and regular grocery items. 
Always output raw JSON. Do not include markdown formatting like \`\`\`json.
`;

    try {
        const response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 1500,
            system: systemPrompt,
            messages: [
                {
                    role: "user",
                    content: `Here is my detailed order history. The current date is ${new Date().toISOString()}:\n\n ${JSON.stringify(detailedOrders)}`
                }
            ],
            temperature: 0.1, // Low temperature for deterministic/analytical output
        });

        const jsonString = response.content[0].text.trim();
        // Remove markdown formatting if Claude disobeys the prompt slightly
        const cleanJson = jsonString.replace(/^```json\s*/, '').replace(/\s*```$/, '');

        const schedule = JSON.parse(cleanJson);
        return schedule;

    } catch (error) {
        console.error("Error analyzing order pattern:", error);
        return null;
    }
}
