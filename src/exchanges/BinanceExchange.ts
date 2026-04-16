import * as ccxt from 'ccxt';
import { BaseExchange } from './BaseExchange';
import { config } from '../config/trading.config';
import { exchangeLogger } from '../utils/logger';

export class BinanceExchange extends BaseExchange {
    constructor(marketType: 'spot' | 'futures' = 'spot') {
        super('binance', marketType);
    }

    protected createExchange(): ccxt.Exchange {
        const options: any = {
            apiKey: config.exchange.apiKey,
            secret: config.exchange.apiSecret,
            enableRateLimit: true,
            options: {
                defaultType: this.marketType === 'futures' ? 'future' : 'spot',
                adjustForTimeDifference: true,
            },
        };

        // Use testnet for paper trading
        if (config.mode === 'paper') {
            if (this.marketType === 'futures') {
                options.urls = {
                    api: {
                        public: 'https://testnet.binancefuture.com/fapi/v1',
                        private: 'https://testnet.binancefuture.com/fapi/v1',
                    },
                };
            } else {
                options.urls = {
                    api: {
                        public: 'https://testnet.binance.vision/api/v3',
                        private: 'https://testnet.binance.vision/api/v3',
                    },
                };
            }
            exchangeLogger.info(`Using Binance ${this.marketType.toUpperCase()} Testnet for paper trading`);
        }

        return new ccxt.binance(options);
    }

    async subscribeToMarketData(
        symbol: string,
        callback: (data: any) => void
    ): Promise<void> {
        exchangeLogger.info(`Subscribing to market data for ${symbol}`);
        const interval = setInterval(async () => {
            try {
                const ticker = await this.fetchTicker(symbol);
                callback(ticker);
            } catch (error) {
                exchangeLogger.error(`Error fetching ticker for ${symbol}:`, error);
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
            await this.exchange.loadMarkets();
            const market = this.exchange.market(symbol);
            return market.limits.amount?.min || 0.001;
        } catch (error) {
            exchangeLogger.error(`Error getting min order amount for ${symbol}:`, error);
            return 0.001;
        }
    }

    async getMinOrderValue(symbol: string): Promise<number> {
        try {
            await this.exchange.loadMarkets();
            const market = this.exchange.market(symbol);
            if (this.marketType === 'spot') {
                return market.limits.cost?.min || 10.0;
            } else {
                return 5.0; // Default for Binance Futures
            }
        } catch (error) {
            exchangeLogger.error(`Error getting min order value for ${symbol}:`, error);
            return 10.0;
        }
    }

    async getTradingFee(symbol: string): Promise<number> {
        try {
            await this.exchange.loadMarkets();
            const market = this.exchange.market(symbol);
            return market.taker || 0.001;
        } catch (error) {
            return 0.001;
        }
    }

    async syncTime(): Promise<void> {
        try {
            const serverTime = await this.exchange.fetchTime();
            if (!serverTime) throw new Error('Failed to fetch server time');

            const localTime = Date.now();
            const timeDifference = localTime - serverTime + 1000;

            this.exchange.options['timeDifference'] = timeDifference;
            this.exchange.options['adjustForTimeDifference'] = true;

            this.exchange.milliseconds = () => {
                return Date.now() - timeDifference;
            };

            exchangeLogger.info(`🕒 Binance Time Sync: Diff=${timeDifference}ms`);
        } catch (error) {
            exchangeLogger.error('Binance Time Sync Failed:', error);
            throw error;
        }
    }
}
