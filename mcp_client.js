import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export class SwiggyClient {
    constructor() {
        this.client = null;
        this.transport = null;
    }

    async connect(authToken) {
        if (!authToken) {
            throw new Error("No Swiggy auth token provided");
        }

        const url = new URL('https://mcp.swiggy.com/im/sse');

        // Setup SSE Transport with Auth Headers
        // The Swiggy MCP uses cookies or bearer tokens derived from OAuth. 
        // Based on typical MCP HTTP setups, we pass the token in headers.
        this.transport = new SSEClientTransport(url, {
            requestInit: {
                headers: {
                    'Authorization': `Bearer ${authToken}`
                }
            }
        });

        this.client = new Client(
            { name: "restock-bot-client", version: "1.0.0" },
            { capabilities: {} }
        );

        try {
            await this.client.connect(this.transport);
            return true;
        } catch (error) {
            console.error("Failed to connect to Swiggy MCP:", error);
            // If we get 401, the token is invalid or expired
            return false;
        }
    }

    async disconnect() {
        if (this.client) {
            await this.client.close();
            this.client = null;
            this.transport = null;
        }
    }

    // Helper to safely call a tool
    async callTool(name, args = {}) {
        if (!this.client) {
            throw new Error("Client not connected");
        }

        try {
            const result = await this.client.callTool({
                name,
                arguments: args
            });
            return result;
        } catch (error) {
            console.error(`Error calling Swiggy tool ${name}:`, error);
            throw error;
        }
    }

    // --- Specific Domain Wrappers ---

    async getOrderHistory() {
        // tool from Swiggy's internal manifest
        return this.callTool('get_order_history', {});
    }

    async getOrderDetails(order_id) {
        return this.callTool('get_order_details', { order_id });
    }

    async searchProducts(query) {
        return this.callTool('search_products', { query });
    }

    async viewCart() {
        return this.callTool('view_cart', {});
    }

    async updateCart(item_id, quantity) {
        return this.callTool('update_cart', { item_id, quantity });
    }

    async getAddresses() {
        return this.callTool('get_addresses', {});
    }
}
