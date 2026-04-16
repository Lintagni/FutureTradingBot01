import * as ccxt from 'ccxt';
import { BaseExchange, Balance } from './BaseExchange';
import { config } from '../config/trading.config';
import { exchangeLogger } from '../utils/logger';

export class BybitExchange extends BaseExchange {
    constructor(marketType: 'spot' | 'futures' = 'spot') {
        super('bybit', marketType);
        exchangeLogger.info(`Initializing Bybit ${marketType.toUpperCase()} Exchange (Build: 2026-02-14 Dual Bot)`);
    }

    private getExchangeSymbol(symbol: string): string {
        if (!symbol || typeof symbol !== 'string') return symbol;

        if (this.marketType === 'futures' && !symbol.includes(':')) {
            const parts = symbol.split('/');
            if (parts.length === 2) {
                return `${symbol}:${parts[1]}`;
            }
        }
        return symbol;
    }

    protected createExchange(): ccxt.Exchange {
        const options: any = {
            apiKey: config.exchange.apiKey,
            secret: config.exchange.apiSecret,
            enableRateLimit: true,
            options: {
                defaultType: this.marketType === 'futures' ? 'swap' : 'spot',
                adjustForTimeDifference: true,
                recvWindow: 120000,
                // Retry configuration for network errors
                retry: true,
                maxRetries: 3,
                retryDelay: 2000, // 2 seconds between retries
            },
            timeout: 60000, // Increased to 60 seconds to handle network delays
        };

        // Bybit Unified Account (required for futures)
        if (this.marketType === 'futures') {
            options.options.defaultType = 'swap';
            options.options.defaultSettle = 'USDT';
        }

        const exchange = new ccxt.bybit(options);

        // NOTE: We do NOT use setSandboxMode / testnet.
        // Bybit testnet is geo-blocked (CloudFront 403) on most cloud providers.
        // Paper trading is fully simulated at the order level — mainnet public APIs
        // are used for real price data only.  No real orders are ever placed.
        if (config.mode === 'paper') {
            exchangeLogger.info('Paper trading mode: using mainnet for prices, orders are simulated locally');
        }

        return exchange;
    }

    async subscribeToMarketData(
        symbol: string,
        callback: (data: any) => void
    ): Promise<void> {
        const exchangeSymbol = this.getExchangeSymbol(symbol);
        exchangeLogger.info(`Subscribing to market data for ${exchangeSymbol}`);
        const interval = setInterval(async () => {
            try {
                const ticker = await this.fetchTicker(exchangeSymbol);
                callback(ticker);
            } catch (error) {
                exchangeLogger.error(`Error fetching ticker for ${exchangeSymbol}:`, error);
            }
        }, 5000);
        (this as any).marketDataInterval = interval;
    }

    unsubscribeFromMarketData(): void {
        if ((this as any).marketDataInterval) {
            clearInterval((this as any).marketDataInterval);
            exchangeLogger.info('Unsubscribed from market data');
        }
    }

    async getMinOrderAmount(symbol: string): Promise<number> {
        try {
            const exchangeSymbol = this.getExchangeSymbol(symbol);
            await this.exchange.loadMarkets();
            const market = this.exchange.market(exchangeSymbol);

            // For futures, sometimes precision.amount (lot size) is the real minimum
            const minLimit = market.limits.amount?.min || 0;
            const precisionAmount = market.precision.amount || 0;

            return Math.max(minLimit, precisionAmount, 0.0001);
        } catch (error) {
            exchangeLogger.error(`Error getting min order amount for ${symbol}:`, error);
            return 0.001;
        }
    }

    async getMinOrderValue(symbol: string): Promise<number> {
        try {
            const exchangeSymbol = this.getExchangeSymbol(symbol);
            await this.exchange.loadMarkets();
            const market = this.exchange.market(exchangeSymbol);

            if (this.marketType === 'spot') {
                return market.limits.cost?.min || 1.0;
            } else {
                // For futures, check amount * price
                const minAmount = market.limits.amount?.min || 0;
                if (minAmount > 0) {
                    try {
                        const ticker = await this.fetchTicker(exchangeSymbol);
                        const minVal = minAmount * ticker.last;
                        // Return the larger of $5 (Bybit default) or the calculated min value + small buffer
                        return Math.max(5.0, minVal * 1.05);
                    } catch (e) {
                        return 10.0; // Safer default if ticker fails
                    }
                }
                return 5.0;
            }
        } catch (error) {
            exchangeLogger.error(`Error getting min order value for ${symbol}:`, error);
            return 5.0;
        }
    }

    // ── Paper trading: skip leverage/margin API calls ──────────────────────
    async setLeverage(symbol: string, leverage: number): Promise<void> {
        if (config.mode === 'paper') {
            exchangeLogger.info(`[PAPER] setLeverage ${leverage}x ${symbol} (simulated)`);
            return;
        }
        return super.setLeverage(symbol, leverage);
    }

    async setMarginMode(symbol: string, marginMode: 'isolated' | 'cross'): Promise<void> {
        if (config.mode === 'paper') {
            exchangeLogger.info(`[PAPER] setMarginMode ${marginMode} ${symbol} (simulated)`);
            return;
        }
        return super.setMarginMode(symbol, marginMode);
    }

    async fetchBalance(currency: string = 'USDT'): Promise<Balance> {
        // Paper mode: return a simulated balance — no real API call needed
        if (config.mode === 'paper') {
            const paperBalance = parseFloat(process.env.PAPER_INITIAL_BALANCE || '10000');
            exchangeLogger.info(`[PAPER] fetchBalance ${currency}: $${paperBalance} (simulated)`);
            return { free: paperBalance, used: 0, total: paperBalance };
        }

        exchangeLogger.info(`[Bybit] fetchBalance called for ${currency}`);
        const balance = await this.exchange.fetchBalance();
        const ccxtBalance = (balance as any)[currency] || { free: 0, used: 0, total: 0 };

        // For Bybit UTA, CCXT maps total equity to USDT. If we are in isolated mode,
        // we might actually need real wallet balance.
        if (balance.info && balance.info.result && balance.info.result.list && balance.info.result.list[0]) {
            const accInfo = balance.info.result.list[0];
            if (accInfo.accountType === 'UNIFIED') {
                // Find the specific coin in the list
                const coinData = accInfo.coin?.find((c: any) => c.coin === currency);
                if (coinData) {
                    // For UTA Isolated Margin, we need real wallet balance minus what's in use
                    const total = parseFloat(coinData.walletBalance || '0') || 0;
                    const used = (parseFloat(coinData.totalOrderIM || '0') || 0) + (parseFloat(coinData.totalPositionIM || '0') || 0);

                    // CCXT's "free" balance for a specific coin in UTA is often more accurate for what is TRADABLE 
                    // vs "availableToWithdraw" which might include unrealized PnL or be locked in ways not suitable for new orders.
                    let free = parseFloat(coinData.availableToWithdraw || '0') || total - used;

                    if (ccxtBalance.free !== undefined && ccxtBalance.free < free) {
                        exchangeLogger.info(`[Bybit UTA] ${currency} CCXT free balance (${ccxtBalance.free}) is lower than manual free (${free}). Preferring CCXT.`);
                        free = ccxtBalance.free;
                    }

                    exchangeLogger.info(`[Bybit UTA] ${currency} wallet: free=${free}, total=${total} (CCXT virtual=${ccxtBalance.free})`);

                    return {
                        free: Math.max(0, free),
                        used,
                        total
                    };
                }
            }
        }

        return {
            free: ccxtBalance.free || 0,
            used: ccxtBalance.used || 0,
            total: ccxtBalance.total || 0
        };
    }

    async getTradingFee(symbol: string): Promise<number> {
        try {
            const exchangeSymbol = this.getExchangeSymbol(symbol);
            await this.exchange.loadMarkets();
            const market = this.exchange.market(exchangeSymbol);
            return market.taker || 0.001;
        } catch (error) {
            exchangeLogger.error(`Error getting trading fee for ${symbol}:`, error);
            return 0.001;
        }
    }

    private async paperFill(symbol: string, side: 'buy' | 'sell', amount: number): Promise<any> {
        const exchangeSymbol = this.getExchangeSymbol(symbol);
        const ticker = await this.fetchTicker(exchangeSymbol);
        const price = ticker.last;
        const fee = price * amount * 0.0006; // 0.06% taker fee
        exchangeLogger.info(`[PAPER] ${side.toUpperCase()} ${amount} ${symbol} @ $${price} (simulated)`);
        return {
            id: `PAPER-${Date.now()}`,
            symbol, side, type: 'market',
            price, average: price, amount,
            filled: amount, cost: price * amount,
            fee: { cost: fee, currency: 'USDT' },
            status: 'closed', timestamp: Date.now(),
        };
    }

    async createMarketBuyOrder(
        symbol: string,
        amount: number,
        stopLoss?: number,
        takeProfit?: number
    ): Promise<any> {
        if (config.mode === 'paper') return this.paperFill(symbol, 'buy', amount);

        const exchangeSymbol = this.getExchangeSymbol(symbol);
        const category = this.marketType === 'futures' ? 'linear' : 'spot';
        const params: any = { category };

        if (this.marketType === 'futures') {
            if (stopLoss) {
                params.stopLoss = this.exchange.priceToPrecision(exchangeSymbol, stopLoss);
            }
            if (takeProfit) {
                params.takeProfit = this.exchange.priceToPrecision(exchangeSymbol, takeProfit);
            }
        }

        let formattedAmount: string | number = amount;
        try {
            formattedAmount = this.exchange.amountToPrecision(exchangeSymbol, amount);
        } catch (e: any) {
            exchangeLogger.warn(`[Bybit] amountToPrecision failed: ${e.message}. Using raw amount.`);
            formattedAmount = amount;
        }

        exchangeLogger.info(`[Bybit] PRE-ORDER: createMarketBuyOrder(${exchangeSymbol}, ${formattedAmount}, ${JSON.stringify(params)})`);
        const order = await this.exchange.createMarketBuyOrder(exchangeSymbol, formattedAmount as any, params);

        // Wait for order to be filled to get execution price and amount
        const filledOrder = await this.waitForOrderFill(order.id, symbol);
        return (this as any).formatOrder(filledOrder || order);
    }

    async createMarketSellOrder(
        symbol: string,
        amount: number,
        stopLoss?: number,
        takeProfit?: number
    ): Promise<any> {
        if (config.mode === 'paper') return this.paperFill(symbol, 'sell', amount);

        const exchangeSymbol = this.getExchangeSymbol(symbol);
        const category = this.marketType === 'futures' ? 'linear' : 'spot';
        const params: any = { category };

        if (this.marketType === 'futures') {
            if (stopLoss) {
                params.stopLoss = this.exchange.priceToPrecision(exchangeSymbol, stopLoss);
            }
            if (takeProfit) {
                params.takeProfit = this.exchange.priceToPrecision(exchangeSymbol, takeProfit);
            }
        }

        let formattedAmount: string | number = amount;
        try {
            formattedAmount = this.exchange.amountToPrecision(exchangeSymbol, amount);
        } catch (e: any) {
            exchangeLogger.warn(`[Bybit] amountToPrecision failed: ${e.message}. Using raw amount.`);
            formattedAmount = amount;
        }

        exchangeLogger.info(`[Bybit] PRE-ORDER: createMarketSellOrder(${exchangeSymbol}, ${formattedAmount}, ${JSON.stringify(params)})`);
        const order = await this.exchange.createMarketSellOrder(exchangeSymbol, formattedAmount as any, params);

        // Wait for order to be filled to get execution price and amount
        const filledOrder = await this.waitForOrderFill(order.id, symbol);
        return (this as any).formatOrder(filledOrder || order);
    }

    async syncTime(): Promise<void> {
        try {
            this.exchange.options['adjustForTimeDifference'] = false;

            const serverTime = await this.exchange.fetchTime();
            if (!serverTime) {
                exchangeLogger.warn('fetchTime returned null — skipping time sync, using local time');
                return;
            }

            const localTime = Date.now();
            const timeDifference = serverTime - localTime;

            this.exchange.options['timeDifference'] = timeDifference;
            this.exchange.options['adjustForTimeDifference'] = true;
            this.exchange.options['recvWindow'] = 120000;
            (this.exchange as any).timeDifference = timeDifference;
            (this.exchange as any).adjustForTimeDifference = true;
            this.exchange.milliseconds = () => Date.now() + timeDifference;

            exchangeLogger.info(`🕒 Bybit Time Sync: Diff=${timeDifference}ms (Local=${localTime}, Server=${serverTime})`);

            try {
                await this.exchange.loadMarkets();
            } catch (e: any) {
                exchangeLogger.warn('Bybit loadMarkets failed (non-critical):', e?.message);
            }
        } catch (error: any) {
            // Time sync failure is non-fatal — bot can still trade with local time
            exchangeLogger.warn(`Bybit Time Sync failed (using local time): ${error?.message}`);
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            // Step 1: sync time (non-fatal)
            await this.syncTime();

            // Step 2: verify public market data is reachable
            try {
                await this.exchange.loadMarkets();
                exchangeLogger.info('✅ Bybit markets loaded');
            } catch (e: any) {
                exchangeLogger.warn('loadMarkets failed:', e?.message);
            }

            // Step 3: verify private API access (API key check)
            try {
                await this.exchange.fetchBalance({ coin: 'USDT' });
                exchangeLogger.info('✅ Bybit API key verified');
            } catch (e: any) {
                // Log clearly but don't abort — paper mode may still function
                exchangeLogger.warn(`Bybit private API check failed: ${e?.message} [type: ${e?.constructor?.name}]`);
            }

            exchangeLogger.info('✅ Bybit Exchange initialised');
            return true;
        } catch (error: any) {
            exchangeLogger.error(`Bybit Connection Failed: ${error?.message} [type: ${error?.constructor?.name}]`);
            return false;
        }
    }
}
