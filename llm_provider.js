import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const provider = process.env.LLM_PROVIDER || 'gemini'; // default to gemini as it's free

const GEMINI_MODEL = "gemini-2.5-flash";
const CLAUDE_MODEL = "claude-3-5-sonnet-20241022";
const OPENAI_MODEL = "gpt-4o-mini";

console.log(`[LLMProvider] Global Config: Provider=${provider}, Model=${GEMINI_MODEL}`);

/**
 * Generic LLM Provider to switch between vendors
 */
export class LLMProvider {
    constructor() {
        this.provider = provider;
        console.log(`[LLMProvider] Initializing with provider: ${this.provider}`);

        if (this.provider === 'anthropic') {
            this.anthropic = new Anthropic({
                apiKey: process.env.ANTHROPIC_API_KEY,
            });
        } else if (this.provider === 'gemini') {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            this.gemini = genAI.getGenerativeModel({ model: GEMINI_MODEL });
        } else if (this.provider === 'openai') {
            this.openai = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
            });
        }
    }

    /**
     * Sends a simple text prompt and expects text/JSON back.
     */
    async generateText(systemPrompt, userPrompt, temperature = 0.1) {
        if (this.provider === 'anthropic') {
            const response = await this.anthropic.messages.create({
                model: CLAUDE_MODEL,
                max_tokens: 2048,
                system: systemPrompt,
                messages: [{ role: "user", content: userPrompt }],
                temperature
            });
            return response.content[0].text;
        } else if (this.provider === 'openai') {
            const response = await this.openai.chat.completions.create({
                model: OPENAI_MODEL,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature
            });
            return response.choices[0].message.content;
        } else {
            // Gemini
            const result = await this.gemini.generateContent({
                contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER INPUT:\n${userPrompt}` }] }],
                generationConfig: {
                    temperature: temperature,
                    maxOutputTokens: 2048,
                }
            });
            return result.response.text();
        }
    }

    /**
     * Handles complex chat with tools (used by agent_brain.js)
     */
    async chatWithTools(systemPrompt, messages, tools, toolHandlers) {
        if (this.provider === 'anthropic') {
            return this._chatAnthropic(systemPrompt, messages, tools, toolHandlers);
        } else if (this.provider === 'openai') {
            return this._chatOpenAI(systemPrompt, messages, tools, toolHandlers);
        } else {
            return this._chatGemini(systemPrompt, messages, tools, toolHandlers);
        }
    }

    async _chatAnthropic(system, messages, tools, handlers) {
        let currentMessages = [...messages];

        let response = await this.anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 1536,
            system,
            messages: currentMessages,
            tools
        });

        while (response.stop_reason === "tool_use") {
            const toolUse = response.content.find(c => c.type === "tool_use");
            if (!toolUse) break;

            const { name, input, id } = toolUse;
            const toolResult = await handlers[name](input);

            currentMessages.push({ role: "assistant", content: response.content });
            currentMessages.push({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(toolResult) }]
            });

            response = await this.anthropic.messages.create({
                model: CLAUDE_MODEL,
                max_tokens: 1536,
                system,
                messages: currentMessages,
                tools
            });
        }

        return response.content[0].text;
    }

    async _chatOpenAI(system, messages, tools, handlers, model = OPENAI_MODEL) {
        let currentMessages = [
            { role: "system", content: system },
            ...messages.map(m => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
            }))
        ];

        // Format tools for OpenAI
        const openAITools = tools.map(t => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema
            }
        }));

        let response = await this.openai.chat.completions.create({
            model: model,
            messages: currentMessages,
            tools: openAITools,
            tool_choice: "auto"
        });

        let responseMessage = response.choices[0].message;

        while (responseMessage.tool_calls) {
            currentMessages.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                const { name, arguments: argsString } = toolCall.function;
                const args = JSON.parse(argsString);
                console.log(`[${this.provider.toUpperCase()}] Executing tool: ${name}`);

                const toolResult = await handlers[name](args);

                currentMessages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: name,
                    content: JSON.stringify(toolResult)
                });
            }

            response = await this.openai.chat.completions.create({
                model: model,
                messages: currentMessages,
                tools: openAITools
            });
            responseMessage = response.choices[0].message;
        }

        return responseMessage.content;
    }

    async _chatGemini(system, messages, tools, handlers) {
        // Initialize model with tools and system instruction at the root level
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            systemInstruction: system,
            tools: [{
                functionDeclarations: tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema
                }))
            }]
        });

        // Map existing messages to Gemini history format (excluding the last one)
        const history = messages.slice(0, -1).map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || "" : m.content }]
        }));

        const lastMessage = messages[messages.length - 1].content;
        const currentQuery = Array.isArray(lastMessage) ? lastMessage.find(c => c.type === 'text')?.text || "" : lastMessage;

        const chat = model.startChat({
            history: history,
            generationConfig: {
                maxOutputTokens: 1536,
                temperature: 0.1
            }
        });

        try {
            console.log(`[Gemini] Sending query: "${currentQuery.substring(0, 50)}..."`);
            let result = await chat.sendMessage(currentQuery);

            let iterations = 0;
            const MAX_ITERATIONS = 5;

            // Recursive tool handling with safety break
            while (result.response.candidates[0].content.parts.some(p => p.functionCall) && iterations < MAX_ITERATIONS) {
                iterations++;
                const parts = result.response.candidates[0].content.parts.filter(p => p.functionCall);

                const functionResponses = [];
                for (const part of parts) {
                    const { name, args } = part.functionCall;
                    console.log(`[Gemini] Iteration ${iterations} - Executing tool: ${name}`);

                    try {
                        const toolResult = await handlers[name](args);
                        console.log(`[Gemini] Tool result for ${name}:`, JSON.stringify(toolResult).substring(0, 200));
                        functionResponses.push({
                            functionResponse: {
                                name,
                                response: { content: toolResult }
                            }
                        });
                    } catch (err) {
                        console.error(`[Gemini] Error in tool ${name}:`, err);
                        functionResponses.push({
                            functionResponse: {
                                name,
                                response: { content: { error: err.message } }
                            }
                        });
                    }
                }

                result = await chat.sendMessage(functionResponses);
            }

            if (iterations >= MAX_ITERATIONS) {
                console.warn("[Gemini] Hit maximum tool-calling iterations safety break.");
            }

            return result.response.text();

        } catch (e) {
            if (e.status === 429 || (e.message && e.message.includes('429'))) {
                console.error("[Gemini] Rate limit hit (429).");
                return "⚠️ **Rate Limit Hit!** Gemini's free tier has a strict limit on how many questions you can ask per minute. Please wait about 60 seconds and try again.";
            }
            throw e;
        }
    }
}
