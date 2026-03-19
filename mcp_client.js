import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HISTORY_FETCH_LIMIT = 20; // Default target for deep history scraping

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

            // 1. Check if the error is due to an expired JWT
            const errorString = error.message || String(error);
            const isJwtExpired = errorString.includes("invalid_token") || errorString.includes("JWT has expired");

            if (isJwtExpired && typeof tokenData === 'object' && tokenData.refresh_token) {
                console.log("[SwiggyClient] Access token expired. Attempting token refresh...");
                try {
                    const refreshResponse = await fetch('https://mcp.swiggy.com/auth/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            grant_type: 'refresh_token',
                            refresh_token: tokenData.refresh_token,
                            client_id: 'restock-bot',
                        }).toString()
                    });

                    const newTokenData = await refreshResponse.json();

                    if (refreshResponse.ok && newTokenData.access_token) {
                        console.log("[SwiggyClient] Token refresh successful. Reconnecting...");
                        
                        // Re-initialize transport with the new token
                        this.transport = new StreamableHTTPClientTransport(url, {
                            requestInit: {
                                headers: {
                                    'Authorization': `Bearer ${newTokenData.access_token}`
                                }
                            }
                        });

                        await this.client.connect(this.transport);
                        
                        // Bubble up the new token so the caller can save it to the DB
                        this.refreshedToken = newTokenData;
                        return true;
                    } else {
                        console.error("[SwiggyClient] Refresh token exchange failed:", newTokenData);
                    }
                } catch (refreshErr) {
                    console.error("[SwiggyClient] Error during token refresh:", refreshErr);
                }
            }

            // If we fail refresh or don't have a token, return false
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

    async getOrders(count = 20, fromTime = Date.now()) {
        // The Swiggy MCP get_orders tool performs a backwards chronological search starting from fromTime.
        // To get the absolute most recent orders, we MUST pass the current timestamp as fromTime.
        // Defaulting to DASH as it correctly includes Instamart orders.
        return this.callTool('get_orders', {
            count,
            orderType: "DASH",
            businessLine: "INSTAMART",
            fromTime
        });
    }

    /**
     * Fetches up to targetCount orders by paginating backwards in time.
     */
    async getDeepOrderHistory(targetCount = HISTORY_FETCH_LIMIT) {
        let allOrders = [];
        let currentFromTime = Date.now();
        let hasMore = true;
        let pagesFetched = 0;
        const maxPages = 5; // Safety cap

        console.log(`[SwiggyClient] Fetching deep history. Target: ${targetCount}`);

        while (allOrders.length < targetCount && hasMore && pagesFetched < maxPages) {
            const response = await this.getOrders(20, currentFromTime);
            const text = response.content?.[0]?.text;
            const data = text ? JSON.parse(text) : {};
            const orders = data.data?.orders || [];
            hasMore = data.data?.hasMore || false;

            if (orders.length === 0) break;

            allOrders = [...allOrders, ...orders];
            pagesFetched++;

            // Use the createdAt of the last order in this batch to search even further back
            const lastOrder = orders[orders.length - 1];
            currentFromTime = new Date(lastOrder.createdAt).getTime();

            console.log(`[SwiggyClient] Page ${pagesFetched}: ${orders.length} orders found. Total: ${allOrders.length}. hasMore: ${hasMore}`);
        }

        return allOrders.slice(0, targetCount);
    }

    async searchProducts(query, addressId) {
        return this.callTool('search_products', { query, addressId });
    }

    async getCart(selectedAddressId) {
        return this.callTool('get_cart', { selectedAddressId });
    }

    async updateCart(spinId, quantity, selectedAddressId) {
        return this.updateCartItems([{ spinId, quantity }], selectedAddressId);
    }

    async updateCartItems(items, selectedAddressId) {
        console.log(`[SwiggyMCP] update_cart CALL: Address=${selectedAddressId}, ItemsCount=${items.length}`);
        if (items.length < 5) console.log(`[SwiggyMCP] Payload Preview:`, JSON.stringify(items));

        try {
            const response = await this.callTool('update_cart', {
                items,
                selectedAddressId
            });
            console.log(`[SwiggyMCP] update_cart RESPONSE:`, JSON.stringify(response).substring(0, 500));
            return response;
        } catch (error) {
            console.error(`[SwiggyMCP] update_cart ERROR:`, error.message);
            throw error;
        }
    }

    async emptyCart(selectedAddressId) {
        console.log(`[SwiggyMCP] Dedicated clear_cart tool requested. (Address ${selectedAddressId} ignored as per tool schema)`);
        try {
            const response = await this.callTool('clear_cart', {});
            console.log(`[SwiggyMCP] clear_cart RESPONSE:`, JSON.stringify(response));
            return response;
        } catch (error) {
            console.error(`[SwiggyMCP] clear_cart ERROR:`, error.message);
            throw error;
        }
    }

    async getAddresses() {
        return this.callTool('get_addresses', {});
    }

    async getGoToItems(addressId) {
        return this.callTool('your_go_to_items', { addressId });
    }
}
