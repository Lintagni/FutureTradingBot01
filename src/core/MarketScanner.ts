import { BaseExchange } from '../exchanges/BaseExchange';
import { IndicatorCalculator } from '../utils/indicators';
import { config } from '../config/trading.config';
import { logger } from '../utils/logger';

export interface PairScore {
    symbol: string;
    score: number;
    adx: number;
    volumeRatio: number;
    atrPct: number;
    rsi: number;
    emaAligned: boolean;
    dailyVolumeUSD: number;
}

// Stablecoins and leveraged tokens to always exclude
const EXCLUDED_BASES = new Set([
    'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'FDUSD', 'PYUSD', 'USDD',
    'FRAX', 'LUSD', 'GUSD', 'SUSD', 'EURC', 'EURT', 'AEUR',
]);

const EXCLUDED_PATTERNS = [
    /\dL$/,   // Leveraged long tokens (e.g. BTC3L)
    /\dS$/,   // Leveraged short tokens (e.g. BTC3S)
    /UP$/,    // Binance leveraged tokens
    /DOWN$/,
    /BULL$/,
    /BEAR$/,
];

export class MarketScanner {
    private exchange: BaseExchange;
    private cachedResults: PairScore[] = [];
    private lastScanTime: number = 0;

    constructor(exchange: BaseExchange) {
        this.exchange = exchange;
    }

    /**
     * Scan market, filter candidates, score, and return top N pairs
     */
    async scanAndRank(): Promise<PairScore[]> {
        const maxPairs = config.scanner.maxActivePairs;

        try {
            logger.info('🔍 MarketScanner: Fetching all USDT tickers...');

            // Step 1: Fetch all tickers
            const tickers = await this.exchange.fetchTickers();

            // Step 2: Filter to USDT spot pairs with sufficient volume
            const candidates = Object.values(tickers)
                .filter((ticker: any) => {
                    const symbol: string = ticker.symbol || '';

                    // Must be USDT pair (handles both spot "BTC/USDT" and futures "BTC/USDT:USDT")
                    if (!symbol.includes('/USDT')) return false;

                    // Extract base currency
                    const base = symbol.split('/')[0];

                    // Exclude stablecoins
                    if (EXCLUDED_BASES.has(base)) return false;

                    // Exclude leveraged tokens
                    if (EXCLUDED_PATTERNS.some(p => p.test(base))) return false;

                    // Minimum price filter
                    const price = ticker.last || ticker.close || 0;
                    if (price < config.scanner.minPrice) return false;

                    // Minimum daily volume (in USDT)
                    const volumeUSD = (ticker.quoteVolume || 0);
                    if (volumeUSD < config.scanner.minDailyVolumeUSD) return false;

                    return true;
                })
                .sort((a: any, b: any) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
                .slice(0, config.scanner.candidatePoolSize);

            logger.info(`🔍 MarketScanner: ${candidates.length} candidates after volume/price filter`);

            if (candidates.length === 0) {
                logger.warn('🔍 MarketScanner: No candidates found');
                return [];
            }

            // Step 3: Fetch candles and calculate indicators for each candidate
            const scoredPairs: PairScore[] = [];

            for (const ticker of candidates) {
                const symbol = (ticker as any).symbol;
                try {
                    const score = await this.scorePair(symbol, ticker as any);
                    if (score) {
                        scoredPairs.push(score);
                    }
                } catch (err) {
                    logger.debug(`🔍 MarketScanner: Failed to score ${symbol}: ${err}`);
                }

                // Small delay to avoid rate limiting
                await new Promise(r => setTimeout(r, 200));
            }

            // Step 4: Sort by score and pick top N
            scoredPairs.sort((a, b) => b.score - a.score);
            const topPairs = scoredPairs.slice(0, maxPairs);

            // Cache results
            this.cachedResults = topPairs;
            this.lastScanTime = Date.now();

            logger.info(`🔍 MarketScanner: Top ${maxPairs} pairs:`);
            for (const pair of topPairs) {
                logger.info(`   📊 ${pair.symbol}: Score=${pair.score.toFixed(1)} | ADX=${pair.adx.toFixed(1)} | Vol=${pair.volumeRatio.toFixed(1)}x | ATR=${pair.atrPct.toFixed(2)}% | RSI=${pair.rsi.toFixed(1)} | EMA=${pair.emaAligned ? '✅' : '❌'}`);
            }

            // Also log runners-up
            if (scoredPairs.length > maxPairs) {
                logger.info(`   --- Runners-up ---`);
                for (const pair of scoredPairs.slice(maxPairs, maxPairs + 3)) {
                    logger.info(`   📊 ${pair.symbol}: Score=${pair.score.toFixed(1)}`);
                }
            }

            return topPairs;
        } catch (err) {
            logger.error('🔍 MarketScanner: Scan failed:', err);

            // Return cached results if available
            if (this.cachedResults.length > 0) {
                logger.info('🔍 MarketScanner: Using cached results from last scan');
                return this.cachedResults;
            }
            return [];
        }
    }

    /**
     * Score a single pair based on technical indicators
     * Returns null if insufficient data
     */
    private async scorePair(symbol: string, ticker: any): Promise<PairScore | null> {
        // Fetch candles for analysis
        const candles = await this.exchange.fetchOHLCV(symbol, config.timeframe, 100);

        if (candles.length < 50) {
            return null;
        }

        // Calculate indicators
        const indicators = IndicatorCalculator.calculate(candles);
        if (!indicators) return null;

        const currentPrice = candles[candles.length - 1].close;
        const dailyVolumeUSD = ticker.quoteVolume || 0;

        // Extract ADX value (handle object or number)
        const adxValue = typeof indicators.adx === 'object'
            ? (indicators.adx as any).adx || 0
            : indicators.adx || 0;

        // Volume ratio (current vs average)
        const volumeRatio = indicators.volumeAvg > 0
            ? candles[candles.length - 1].volume / indicators.volumeAvg
            : 1.0;

        // ATR as percentage of price (volatility measure)
        const atrPct = (indicators.atr / currentPrice) * 100;

        // EMA alignment check (EMA9 > EMA21 = uptrend)
        const emaAligned = indicators.ema9 > indicators.ema21 && currentPrice > indicators.ema9;

        // ─── SCORING ───
        let score = 0;

        // 1. ADX Score (30% weight) — favor trending markets
        // ADX 20-25 = ok, 25-40 = good, 40+ = very strong
        if (adxValue >= 25) {
            score += Math.min(30, (adxValue / 40) * 30);
        } else if (adxValue >= 20) {
            score += (adxValue / 25) * 15; // Partial credit
        }
        // ADX < 20 = ranging → low score

        // 2. Volume Ratio Score (25% weight) — favor high relative volume
        // 1.0x = average, 1.5x+ = good, 2x+ = excellent
        if (volumeRatio >= 1.2) {
            score += Math.min(25, (volumeRatio / 2.0) * 25);
        }

        // 3. ATR% Score (20% weight) — need enough volatility for profit
        // Too low = can't reach TP, too high = risky
        // Sweet spot: 0.3% - 2.0% on 15m candles
        if (atrPct >= 0.3 && atrPct <= 2.0) {
            score += 20 * (atrPct / 1.0); // 1% ATR = full 20 points
            score = Math.min(score, score); // Natural cap from formula
        } else if (atrPct > 2.0) {
            score += 15; // Still ok but slightly less ideal (too volatile)
        }

        // 4. RSI Score (15% weight) — favor early momentum, not overbought
        // RSI 40-60 = best for new entries (room to move)
        // RSI > 70 or < 30 = already extended
        if (indicators.rsi >= 40 && indicators.rsi <= 60) {
            score += 15;
        } else if (indicators.rsi >= 30 && indicators.rsi <= 70) {
            score += 8;
        }
        // RSI < 30 or > 70 = 0 points (already extended)

        // 5. EMA Alignment Score (10% weight) — uptrend confirmation
        if (emaAligned) {
            score += 10;
        } else if (indicators.ema9 > indicators.ema21) {
            score += 5; // Partial — EMA trending but price dipped below
        }

        return {
            symbol,
            score,
            adx: adxValue,
            volumeRatio,
            atrPct,
            rsi: indicators.rsi,
            emaAligned,
            dailyVolumeUSD,
        };
    }

    /**
     * Get cached results (for status display)
     */
    getCachedResults(): PairScore[] {
        return this.cachedResults;
    }

    /**
     * Get time since last scan in minutes
     */
    getMinutesSinceLastScan(): number {
        if (this.lastScanTime === 0) return -1;
        return (Date.now() - this.lastScanTime) / (1000 * 60);
    }
}
