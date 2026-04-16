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

        // Use testnet for paper trading
        if (config.mode === 'paper') {
            options.urls = {
                api: {
                    public: 'https://api-testnet.bybit.com',
                    private: 'https://api-testnet.bybit.com',
                },
            };
            exchangeLogger.info('Using Bybit Testnet for paper trading');
        }

        const exchange = new ccxt.bybit(options);

        // Use setSandboxMode if available
        if (config.mode === 'paper' && exchange.setSandboxMode) {
            exchange.setSandboxMode(true);
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

    async fetchBalance(currency: string = 'USDT'): Promise<Balance> {
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

    async createMarketBuyOrder(
        symbol: string,
        amount: number,
        stopLoss?: number,
        takeProfit?: number
    ): Promise<any> {
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
            // Force disable sync briefly to get a clean public server time
            this.exchange.options['adjustForTimeDifference'] = false;

            const serverTime = await this.exchange.fetchTime();
            if (!serverTime) throw new Error('Failed to fetch server time from public endpoint');

            const localTime = Date.now();
            const timeDifference = serverTime - localTime;

            // Apply offset to ALL possible CCXT locations
            this.exchange.options['timeDifference'] = timeDifference;
            this.exchange.options['adjustForTimeDifference'] = true;
            this.exchange.options['recvWindow'] = 120000;

            (this.exchange as any).timeDifference = timeDifference;
            (this.exchange as any).adjustForTimeDifference = true;

            // Nuclear option: override milliseconds to return server-relative time 
            this.exchange.milliseconds = () => Date.now() + timeDifference;

            exchangeLogger.info(`🕒 Bybit Time Sync: Diff=${timeDifference}ms (Local=${localTime}, Server=${serverTime})`);

            // Try to load markets only after sync is applied
            try {
                // Bybit's loadMarkets calls fetchCurrencies (private), so we NEED the offset first
                await this.exchange.loadMarkets();
            } catch (e) {
                exchangeLogger.warn('Bybit loadMarkets failed (non-critical if metadata exists):', e);
            }
        } catch (error) {
            exchangeLogger.error('Bybit Time Sync Failed:', error);
            throw error;
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            await this.syncTime();

            // Test actual connectivity with a small private call if possible
            await this.exchange.fetchBalance({ coin: 'USDT' }).catch(() => { });

            exchangeLogger.info('✅ Bybit Connected and Synchronized');
            return true;
        } catch (error) {
            exchangeLogger.error('Bybit Connection Failed:', error);
            return false;
        }
    }
}
