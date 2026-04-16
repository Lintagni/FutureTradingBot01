import * as ccxt from 'ccxt';
import { OHLCV } from '../utils/indicators';

export interface OrderResult {
    id: string;
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    price: number;
    amount: number;
    cost: number;
    fee: number;
    timestamp: number;
}

export interface Balance {
    free: number;
    used: number;
    total: number;
}

export interface Ticker {
    symbol: string;
    bid: number;
    ask: number;
    last: number;
    volume: number;
    timestamp: number;
}

export abstract class BaseExchange {
    protected exchange: ccxt.Exchange;
    protected name: string;
    protected marketType: 'spot' | 'futures';

    constructor(name: string, marketType: 'spot' | 'futures' = 'spot') {
        this.name = name;
        this.marketType = marketType;
        this.exchange = this.createExchange();
    }

    protected abstract createExchange(): ccxt.Exchange;

    /**
     * Get minimum order amount for a symbol
     */
    abstract getMinOrderAmount(symbol: string): Promise<number>;

    /**
     * Get minimum order value for a symbol
     */
    abstract getMinOrderValue(symbol: string): Promise<number>;

    /**
     * Fetch account balance for a specific currency
     */
    async fetchBalance(currency: string = 'USDT'): Promise<Balance> {
        const balance = await this.exchange.fetchBalance();
        const currencyBalance = balance[currency] || { free: 0, used: 0, total: 0 };

        return {
            free: currencyBalance.free || 0,
            used: currencyBalance.used || 0,
            total: currencyBalance.total || 0,
        };
    }

    /**
     * Set leverage for a symbol (Futures only)
     */
    async setLeverage(symbol: string, leverage: number): Promise<void> {
        if (this.marketType !== 'futures') return;
        try {
            if (this.exchange.setLeverage) {
                await this.exchange.setLeverage(leverage, symbol);
                console.log(`[${this.name}] Leverage set to ${leverage}x for ${symbol}`);
            }
        } catch (error) {
            console.warn(`[${this.name}] Failed to set leverage (may be already set):`, error);
        }
    }

    /**
     * Set margin mode (Futures only)
     */
    async setMarginMode(symbol: string, marginMode: 'isolated' | 'cross'): Promise<void> {
        if (this.marketType !== 'futures') return;
        try {
            if (this.exchange.setMarginMode) {
                await this.exchange.setMarginMode(marginMode, symbol);
                console.log(`[${this.name}] Margin mode set to ${marginMode} for ${symbol}`);
            }
        } catch (error) {
            console.warn(`[${this.name}] Failed to set margin mode (may be already set):`, error);
        }
    }

    /**
     * Create a market buy order
     */
    async createMarketBuyOrder(
        symbol: string,
        amount: number,
        _stopLoss?: number,
        _takeProfit?: number
    ): Promise<OrderResult> {
        let formattedAmount: string | number = amount;
        try {
            formattedAmount = this.exchange.amountToPrecision(symbol, amount);
        } catch (e: any) {
            console.warn(`[BaseExchange] amountToPrecision failed for ${symbol}: ${e.message}. Using raw amount.`);
            // If it failed because it's too small, this won't help, but we pass it anyway to let the exchange fail gracefully
            formattedAmount = amount;
        }

        const order = await this.exchange.createMarketBuyOrder(symbol, formattedAmount as any);
        const filledOrder = await this.waitForOrderFill(order.id, symbol);
        return this.formatOrder(filledOrder || order);
    }

    /**
     * Create a market sell order
     */
    async createMarketSellOrder(
        symbol: string,
        amount: number,
        _stopLoss?: number,
        _takeProfit?: number
    ): Promise<OrderResult> {
        let formattedAmount: string | number = amount;
        try {
            formattedAmount = this.exchange.amountToPrecision(symbol, amount);
        } catch (e: any) {
            console.warn(`[BaseExchange] amountToPrecision failed for ${symbol}: ${e.message}. Using raw amount.`);
            formattedAmount = amount;
        }

        const order = await this.exchange.createMarketSellOrder(symbol, formattedAmount as any);
        const filledOrder = await this.waitForOrderFill(order.id, symbol);
        return this.formatOrder(filledOrder || order);
    }

    /**
     * Wait for an order to be filled
     */
    protected async waitForOrderFill(orderId: string, symbol: string): Promise<any> {
        let order;
        // Try up to 5 times (5 seconds)
        for (let i = 0; i < 5; i++) {
            try {
                // Wait 1 second before first/next check
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Bybit specific: Requires params to find order sometimes
                try {
                    order = await this.exchange.fetchOrder(orderId, symbol);
                } catch (e: any) {
                    // If Bybit complains about "acknowledged" or not found, try to find it in closed orders
                    if (e.message && (e.message.includes('last 500 orders') || e.message.includes('not found'))) {
                        console.log(`[BaseExchange] fetchOrder failed, trying fetchClosedOrders...`);
                        const closedOrders = await this.exchange.fetchClosedOrders(symbol, undefined, 5);
                        order = closedOrders.find(o => o.id === orderId);

                        if (!order) {
                            // Try open orders too
                            const openOrders = await this.exchange.fetchOpenOrders(symbol, undefined, 5);
                            order = openOrders.find(o => o.id === orderId);
                        }
                    } else {
                        throw e;
                    }
                }

                if (!order) {
                    console.warn(`[BaseExchange] Order ${orderId} not found in fetchOrder/fetchClosedOrders.`);
                    continue;
                }

                // Detailed debug logging
                console.log(`[BaseExchange] Poll ${i + 1}/5 for ${orderId}: Status=${order.status}, Filled=${order.filled}, Price=${order.price}, Avg=${order.average}`);

                // If filled or closed, we have the final price
                if (order.status === 'closed' || (order.filled && order.filled > 0)) {
                    // Double check we have a valid price
                    if (order.average || order.price) {
                        return order;
                    }

                    // Fallback: Fetch My Trades (Fills) if price is missing
                    try {
                        console.log(`[BaseExchange] Order closed but price missing. Fetching trades for ${orderId}...`);
                        const trades = await this.exchange.fetchMyTrades(symbol, undefined, 5); // Last 5 trades
                        const fill = trades.find(t => t.order === orderId);
                        if (fill) {
                            console.log(`[BaseExchange] Found fill: Price=${fill.price}, Amount=${fill.amount}`);
                            // Patch the order object with fill details
                            order.price = fill.price;
                            order.average = fill.price;
                            order.filled = fill.amount || 0;
                            if (!order.cost) order.cost = fill.cost || 0;
                            return order;
                        }
                    } catch (err) {
                        console.warn(`[BaseExchange] Failed to fetch trades for fallback:`, err);
                    }
                }
            } catch (error) {
                console.warn(`Attempt ${i + 1}: Failed to fetch order ${orderId}:`, error);
            }
        }

        console.warn(`Order ${orderId} did not complete filling within 5s timeout.`);
        return order; // Return last known state
    }

    /**
     * Create a limit order
     */
    async createLimitOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        price: number
    ): Promise<OrderResult> {
        const order = await this.exchange.createLimitOrder(symbol, side, amount, price);
        return this.formatOrder(order);
    }

    /**
     * Cancel an order
     */
    async cancelOrder(orderId: string, symbol: string): Promise<void> {
        await this.exchange.cancelOrder(orderId, symbol);
    }

    /**
     * Fetch all tickers (for MarketScanner)
     */
    async fetchTickers(): Promise<{ [symbol: string]: any }> {
        return await this.exchange.fetchTickers();
    }

    /**
     * Fetch available spot markets
     */
    async fetchMarkets(): Promise<any[]> {
        return await this.exchange.fetchMarkets();
    }

    /**
     * Fetch current ticker data
     */
    async fetchTicker(symbol: string): Promise<Ticker> {
        const ticker = await this.exchange.fetchTicker(symbol);

        return {
            symbol,
            bid: ticker.bid || 0,
            ask: ticker.ask || 0,
            last: ticker.last || 0,
            volume: ticker.baseVolume || 0,
            timestamp: ticker.timestamp || Date.now(),
        };
    }

    /**
     * Fetch OHLCV candles
     */
    async fetchOHLCV(
        symbol: string,
        timeframe: string = '15m',
        limit: number = 100
    ): Promise<OHLCV[]> {
        const candles = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

        return candles.map((candle: any) => ({
            timestamp: candle[0],
            open: candle[1],
            high: candle[2],
            low: candle[3],
            close: candle[4],
            volume: candle[5],
        }));
    }

    /**
     * Get exchange name
     */
    getName(): string {
        return this.name;
    }

    /**
     * Synchronize time with exchange server
     */
    async syncTime(): Promise<void> {
        // Default implementation just fetches time to verify connectivity
        // Specific exchanges can override this with custom sync logic
        await this.exchange.fetchTime();
    }

    /**
     * Check if exchange is connected
     */
    async testConnection(): Promise<boolean> {
        try {
            await this.syncTime();
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Format order response
     */
    private formatOrder(order: any): OrderResult {
        return {
            id: order.id,
            symbol: order.symbol,
            side: order.side,
            type: order.type,
            price: order.average || order.price || 0,
            amount: order.filled || order.amount || 0,
            cost: order.cost || 0,
            fee: order.fee?.cost || 0,
            timestamp: order.timestamp || Date.now(),
        };
    }
}
