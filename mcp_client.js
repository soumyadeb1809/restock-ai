import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class SwiggyClient {
    constructor() {
        this.client = null;
        this.transport = null;
    }

    async connect(tokenData) {
        if (!tokenData) {
            throw new Error("No Swiggy auth token provided");
        }

        // tokenData can be a full object {access_token, refresh_token, ...} or a plain string
        const accessToken = typeof tokenData === 'string'
            ? tokenData
            : tokenData.access_token;

        if (!accessToken) {
            throw new Error("Invalid token: access_token is missing");
        }

        const url = new URL('https://mcp.swiggy.com/im');

        this.transport = new StreamableHTTPClientTransport(url, {
            requestInit: {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
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

    async getOrders(count = 10) {
        return this.callTool('get_orders', { count, orderType: "INSTAMART" });
    }

    async getOrderDetails(orderId) {
        return this.callTool('get_order_details', { orderId });
    }

    async searchProducts(query, addressId) {
        return this.callTool('search_products', { query, addressId });
    }

    async getCart(selectedAddressId) {
        return this.callTool('get_cart', { selectedAddressId });
    }

    async updateCart(spinId, quantity, selectedAddressId) {
        return this.callTool('update_cart', {
            items: [{ spinId, quantity }],
            selectedAddressId
        });
    }

    async getAddresses() {
        return this.callTool('get_addresses', {});
    }
}
