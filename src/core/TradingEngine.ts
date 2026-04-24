import { BaseExchange } from '../exchanges/BaseExchange';
import { BaseStrategy, TradeSignal } from '../strategies/BaseStrategy';
import { riskManager, RiskManager } from '../risk/RiskManager';
import { tradeRepository } from '../database/TradeRepository';
import { IndicatorCalculator } from '../utils/indicators';
import { logger, tradeLogger } from '../utils/logger';
import { notifier } from '../utils/notifier';
import { webServer } from '../utils/WebServer';
import { config } from '../config/trading.config';

import { aiLearning, extractFeatures } from './AdaptiveLearning';
import { MarketScanner, PairScore } from './MarketScanner';
import { autoRetrainer } from '../ai/AutoRetrainer';
import { getFearAndGreed } from '../utils/marketContext';

/**
 * Retry wrapper for API calls with exponential backoff
 * Helps handle transient network errors gracefully
 */
async function withRetry<T>(
    fn: () => Promise<T>,
    operation: string,
    maxRetries: number = 3
): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;

            // Check if error is retryable (network-related)
            const isRetryable =
                error.message?.includes('ECONNRESET') ||
                error.message?.includes('ETIMEDOUT') ||
                error.message?.includes('ENOTFOUND') ||
                error.message?.includes('timeout') ||
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT';

            if (!isRetryable || attempt === maxRetries) {
                // Not retryable or final attempt - throw the error
                throw error;
            }

            // Exponential backoff: 1s, 2s, 4s...
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
            logger.warn(`⚠️ ${operation} failed (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`, error.message);

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

interface Position {
    tradeId: string;
    symbol: string;
    side: 'buy' | 'sell'; // 'buy' = LONG, 'sell' = SHORT (futures)
    entryPrice: number;
    amount: number;
    stopLoss: number;
    takeProfit: number;
    strategy: string;
    leverage: number;   // Futures leverage (e.g. 3 for 3x)
    openedAt: number;   // timestamp when opened
    highestPrice: number; // LONG: tracks highest price; SHORT: tracks lowest price
    partialExitDone: boolean; // true after 50% has been closed at ATR×2 profit
}

export class TradingEngine {
    private exchange: BaseExchange;
    private strategy: BaseStrategy;
    private positions: Map<string, Position> = new Map();
    private isRunning: boolean = false;
    private marketDataIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

    // ─── Loss cooldown tracking ───
    private consecutiveLosses: Map<string, number> = new Map();
    private cooldownRemaining: Map<string, number> = new Map();

    // ─── Market Scanner ───
    private marketScanner: MarketScanner | null = null;
    private scannerInterval: ReturnType<typeof setInterval> | null = null;
    private activePairs: string[] = [];
    private timeSyncInterval: ReturnType<typeof setInterval> | null = null;

    // ─── Higher-Timeframe trend cache (15-min TTL per symbol) ────────────────
    private htfCache: Map<string, { bullish1h: boolean | null; bullish4h: boolean | null; cachedAt: number }> = new Map();

    constructor(exchange: BaseExchange, strategy: BaseStrategy) {
        this.exchange = exchange;
        this.strategy = strategy;
    }

    /**
     * Start the trading engine
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('Trading engine is already running');
            return;
        }

        logger.info('🚀 Starting trading engine...');
        this.isRunning = true;

        // ensure connection and sync time
        logger.info('🔌 Connecting to exchange and syncing time...');
        const isConnected = await this.exchange.testConnection();
        if (!isConnected) {
            if (config.mode === 'paper') {
                logger.warn('⚠️  Price feed check failed in paper mode — will retry on first trade cycle.');
            } else {
                logger.error('❌ Failed to connect to exchange. Aborting start.');
                this.isRunning = false;
                return;
            }
        }

        // Repair any trades stored with NULL realizedPnl (legacy NaN-fee bug)
        await tradeRepository.repairNullPnl('futures');

        // Initial learning from past futures trades
        await aiLearning.learn('futures');

        // Restore open positions from database
        await this.restoreState();

        // ─── Auto Pair Selection ───
        if (config.autoPairSelection) {
            logger.info('🔍 Auto Pair Selection enabled — initializing MarketScanner...');
            this.marketScanner = new MarketScanner(this.exchange);

            // Do initial scan — pass current balance for tier-aware pair selection
            try {
                let scanBalance: number | undefined;
                try { const bal = await this.exchange.fetchBalance(); scanBalance = bal.free; } catch (_) {}
                const bestPairs = await this.marketScanner.scanAndRank(scanBalance);
                const scannerSymbols = bestPairs.map((p: PairScore) => p.symbol);
                const currentPositions = Array.from(this.positions.keys());

                if (scannerSymbols.length === 0) {
                    // Scanner returned empty (e.g. auth failure in paper mode) — fall back to configured pairs
                    logger.warn('📊 MarketScanner returned no pairs — using fallback pairs from config');
                    this.activePairs = Array.from(new Set([...config.tradingPairs, ...currentPositions]));
                } else {
                    // CRITICAL FIX: Always include current open positions in monitoring
                    this.activePairs = Array.from(new Set([...scannerSymbols, ...currentPositions]));
                    logger.info(`📊 MarketScanner selected: ${scannerSymbols.join(', ')}`);
                    if (currentPositions.length > 0) {
                        logger.info(`♻️ [FUTURES] Also monitoring open positions: ${currentPositions.join(', ')}`);
                    }
                }
            } catch (err) {
                logger.error('📊 MarketScanner initial scan failed, using fallback pairs:', err);
                const currentPositions = Array.from(this.positions.keys());
                this.activePairs = Array.from(new Set([...config.tradingPairs, ...currentPositions]));
            }

            // Schedule periodic re-scans
            const scanMs = config.scanner.scanIntervalMinutes * 60 * 1000;
            this.scannerInterval = setInterval(async () => {
                await this.rescanPairs();
            }, scanMs);
        } else {
            this.activePairs = [...config.tradingPairs];
        }

        // Start loops for active pairs
        this.marketDataIntervals.clear();
        for (const pair of this.activePairs) {
            await this.processSymbol(pair);
        }

        // Start periodic time sync (every 30 minutes)
        this.timeSyncInterval = setInterval(async () => {
            try {
                await this.exchange.syncTime();
            } catch (err) {
                logger.error('❌ Failed periodic time sync:', err);
            }
        }, 10 * 60 * 1000);

        logger.info(`✅ [FUTURES] Trading engine started successfully — monitoring: ${this.activePairs.join(', ')} | Leverage: ${config.futures.leverage}x | Margin: ${config.futures.marginMode}`);
    }

    /**
     * Re-scan market and update active pairs
     */
    private async rescanPairs(): Promise<void> {
        if (!this.marketScanner || !this.isRunning) return;

        try {
            logger.info('🔍 MarketScanner: Syncing time before re-scanning...');
            await this.exchange.syncTime();

            logger.info('🔍 MarketScanner: Re-scanning market...');
            let scanBalance: number | undefined;
            try { const bal = await this.exchange.fetchBalance(); scanBalance = bal.free; } catch (_) {}
            const bestPairs = await this.marketScanner.scanAndRank(scanBalance);

            if (bestPairs.length === 0) {
                logger.warn('🔍 MarketScanner: No good pairs found, keeping current selection');
                return;
            }

            const newPairSymbols = bestPairs.map((p: PairScore) => p.symbol);
            const oldPairs = [...this.activePairs];
            const currentPositionSymbols = Array.from(this.positions.keys());

            // Merge scanner results with open positions
            const targetPairs = Array.from(new Set([...newPairSymbols, ...currentPositionSymbols]));

            // Find pairs to add and remove
            const pairsToAdd = targetPairs.filter((p: string) => !oldPairs.includes(p));
            const pairsToRemove = oldPairs.filter(p => !targetPairs.includes(p));

            // Safety check: Don't remove pairs that have open positions (already handled by targetPairs merge, but being explicit)
            const safeToRemove = pairsToRemove.filter(p => !this.positions.has(p));

            // Update active list
            this.activePairs = [...targetPairs];

            // Stop monitoring removed pairs
            for (const pair of safeToRemove) {
                const interval = this.marketDataIntervals.get(pair);
                if (interval) {
                    clearTimeout(interval);
                    this.marketDataIntervals.delete(pair);
                }
            }

            // Start monitoring new pairs
            for (const pair of pairsToAdd) {
                this.processSymbol(pair);
            }

            if (pairsToAdd.length > 0 || safeToRemove.length > 0) {
                logger.info(`📊 MarketScanner update: +[${pairsToAdd.join(', ')}] -[${safeToRemove.join(', ')}] → Active: ${this.activePairs.join(', ')}`);

                // Notify via Telegram
                const scores = bestPairs.map((p: PairScore) => `${p.symbol}: ${p.score.toFixed(0)}pts`).join('\n');
                await notifier.sendMessage(`🔍 **Market Scanner Update**\n\nBest pairs:\n${scores}\n\nActive: ${this.activePairs.join(', ')}`);
            } else {
                logger.info(`📊 MarketScanner: No change — still monitoring ${this.activePairs.join(', ')}`);
            }
        } catch (err) {
            logger.error('📊 MarketScanner re-scan failed:', err);
        }
    }

    /**
     * Restore state from database
     */
    private async restoreState(): Promise<void> {
        try {
            const openTrades = await tradeRepository.getOpenTrades(undefined, 'futures');
            if (openTrades.length > 0) {
                logger.info(`♻️ [FUTURES] Restoring ${openTrades.length} open positions from database...`);
                for (const trade of openTrades) {
                    const slPct = config.risk.stopLossPercentage;
                    const tpPct = config.risk.takeProfitPercentage;
                    const isShort = trade.side === 'sell';
                    const leverage = (trade as any).leverage || config.futures.leverage;

                    // SHORT: SL is above entry, TP is below entry
                    const stopLoss = isShort
                        ? trade.entryPrice * (1 + slPct / 100)
                        : trade.entryPrice * (1 - slPct / 100);
                    const takeProfit = isShort
                        ? trade.entryPrice * (1 - tpPct / 100)
                        : trade.entryPrice * (1 + tpPct / 100);

                    this.positions.set(trade.symbol, {
                        tradeId: trade.id,
                        symbol: trade.symbol,
                        side: trade.side as 'buy' | 'sell',
                        entryPrice: trade.entryPrice,
                        amount: trade.amount,
                        stopLoss,
                        takeProfit,
                        strategy: trade.strategy,
                        leverage,
                        openedAt: new Date(trade.createdAt).getTime(),
                        highestPrice: trade.entryPrice, // Will track from now
                        partialExitDone: false,
                    });
                    logger.info(`   - Restored ${trade.symbol} (${isShort ? 'SHORT' : 'LONG'}, Size: ${trade.amount}, ${leverage}x)`);
                }
            }
        } catch (error) {
            logger.error(`[FUTURES] Failed to restore state:`, error);
        }
    }

    /**
     * Stop the trading engine
     */
    stop(reason?: string): void {
        this.isRunning = false;
        logger.info(`🛑 Stopping trading engine... ${reason ? `(${reason})` : ''}`);

        // Stop scanner
        if (this.scannerInterval) {
            clearInterval(this.scannerInterval);
            this.scannerInterval = null;
        }

        // Stop time sync
        if (this.timeSyncInterval) {
            clearInterval(this.timeSyncInterval);
            this.timeSyncInterval = null;
        }

        // Stop market data subscriptions
        for (const [symbol, interval] of this.marketDataIntervals) {
            if ((this.exchange as any).unsubscribeFromMarketData) {
                (this.exchange as any).unsubscribeFromMarketData();
            }
            clearTimeout(interval);
            logger.info(`Stopped monitoring ${symbol}`);
        }
        this.marketDataIntervals.clear();

        logger.info('✅ Trading engine stopped');
    }

    /**
     * Fetch 1h and 4h EMA trends for a symbol (cached 15 min).
     * Returns null booleans if data is unavailable — callers treat null as neutral.
     */
    private async fetchHTFTrend(symbol: string): Promise<{ bullish1h: boolean | null; bullish4h: boolean | null }> {
        const cached = this.htfCache.get(symbol);
        if (cached && Date.now() - cached.cachedAt < 15 * 60 * 1000) {
            return { bullish1h: cached.bullish1h, bullish4h: cached.bullish4h };
        }
        let bullish1h: boolean | null = null;
        let bullish4h: boolean | null = null;
        try {
            const candles1h = await this.exchange.fetchOHLCV(symbol, '1h', 50);
            const ind1h = candles1h.length >= 30 ? IndicatorCalculator.calculate(candles1h) : null;
            if (ind1h) bullish1h = ind1h.ema9 > ind1h.ema21;
        } catch (_) {}
        try {
            const candles4h = await this.exchange.fetchOHLCV(symbol, '4h', 30);
            const ind4h = candles4h.length >= 20 ? IndicatorCalculator.calculate(candles4h) : null;
            if (ind4h) bullish4h = ind4h.ema9 > ind4h.ema21;
        } catch (_) {}
        this.htfCache.set(symbol, { bullish1h, bullish4h, cachedAt: Date.now() });
        return { bullish1h, bullish4h };
    }

    private async processSymbol(symbol: string): Promise<void> {
        if (!this.isRunning) return;

        const startTime = Date.now();
        const timeoutMs = 50000; // 50 second timeout for analysis
        let completed = false;

        try {
            logger.info(`🔄 [FUTURES] Processing ${symbol}...`);

            // ─── Loss Cooldown Check ───
            const cooldown = this.cooldownRemaining.get(symbol) || 0;
            if (cooldown > 0) {
                this.cooldownRemaining.set(symbol, cooldown - 1);
                logger.info(`⏸️ [${symbol}] Loss cooldown: ${cooldown} cycles remaining, skipping analysis`);
                return;
            }

            // Use a Promise.race to ensure we don't hang forever on a single symbol
            await Promise.race([
                (async () => {
                    // Fetch market data with retry logic
                    const candles = await withRetry(
                        () => this.exchange.fetchOHLCV(symbol, config.timeframe, 100),
                        `Fetch OHLCV for ${symbol}`
                    );

                    if (candles.length < 50) {
                        logger.warn(`Insufficient candles for ${symbol}`);
                        return;
                    }

                    // Save latest candle to database
                    const latestCandle = candles[candles.length - 1];
                    await tradeRepository.saveMarketData({
                        exchange: this.exchange.getName(),
                        symbol,
                        timeframe: config.timeframe,
                        timestamp: new Date(latestCandle.timestamp),
                        open: latestCandle.open,
                        high: latestCandle.high,
                        low: latestCandle.low,
                        close: latestCandle.close,
                        volume: latestCandle.volume,
                    });

                    // Calculate indicators
                    const indicators = IndicatorCalculator.calculate(candles);
                    if (!indicators) {
                        logger.warn(`Could not calculate indicators for ${symbol}`);
                        return;
                    }

                    // Generate signal
                    const signal = this.strategy.analyze(candles, indicators);

                    // Save signal to database
                    await tradeRepository.saveSignal({
                        exchange: this.exchange.getName(),
                        symbol,
                        strategy: this.strategy.getName(),
                        signal: signal.signal,
                        confidence: signal.confidence,
                        price: signal.price,
                        indicators: JSON.stringify(indicators),
                        marketType: 'futures',
                    });

                    // Broadcast signal
                    webServer.broadcast('signal', {
                        symbol,
                        signal: signal.signal,
                        confidence: signal.confidence,
                        price: signal.price,
                        timestamp: Date.now(),
                    });

                    // ─── Fetch Higher-Timeframe trend (cached 15 min) ───────────
                    let htfBullish1h: boolean | null = null;
                    let htfBullish4h: boolean | null = null;
                    try {
                        const htf = await this.fetchHTFTrend(symbol);
                        htfBullish1h = htf.bullish1h;
                        htfBullish4h = htf.bullish4h;
                    } catch (_) {}

                    // Check if we have an open position
                    const position = this.positions.get(symbol);

                    if (position) {
                        // Manage existing position
                        await this.managePosition(symbol, position, signal);
                    } else {
                        // Look for entry opportunity
                        await this.lookForEntry(symbol, signal, htfBullish1h, htfBullish4h);
                    }
                    completed = true;
                })(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Timeout processing ${symbol} after ${timeoutMs}ms`)), timeoutMs)
                )
            ]);

        } catch (error: any) {
            // Log different error types appropriately
            if (error.message?.includes('Timeout processing')) {
                logger.error(`⏱️ [FUTURES] Timeout processing ${symbol}:`, error.message);
            } else {
                logger.error(`❌ [FUTURES] Error processing ${symbol}:`, error.message || error);
            }
        } finally {
            const duration = Date.now() - startTime;
            if (completed) {
                logger.debug(`✅ [FUTURES] Finished ${symbol} in ${duration}ms`);
            }

            // ALWAYS schedule next check if engine is still running
            if (this.isRunning) {
                const interval = setTimeout(() => this.processSymbol(symbol), 60000);
                this.marketDataIntervals.set(symbol, interval);
            }
        }
    }

    /**
     * Look for entry opportunity — supports both LONG and SHORT for futures.
     * htfBullish1h / htfBullish4h: higher-timeframe EMA trend (null = unknown).
     */
    private async lookForEntry(
        symbol: string,
        signal: TradeSignal,
        htfBullish1h: boolean | null = null,
        htfBullish4h: boolean | null = null,
    ): Promise<void> {
        // Only act on directional signals, not hold
        if (signal.signal === 'hold') return;

        // In-memory fast check — prevents wasted API calls when max positions already reached
        if (this.positions.size >= config.risk.maxOpenPositions) return;

        const isLong = signal.direction === 'long';
        const isShort = signal.direction === 'short';
        if (!isLong && !isShort) return;

        const side: 'buy' | 'sell' = isLong ? 'buy' : 'sell';
        const dirLabel = isLong ? 'LONG' : 'SHORT';

        // LEARNING UPDATE: Check AI Adjustment
        await aiLearning.learn('futures');
        const baseThreshold = aiLearning.getConfidenceThreshold('futures');
        const riskMult = aiLearning.getRiskMultiplier('futures');

        // Check if indicators are valid
        if (!signal.indicators) {
            logger.warn('Signal missing indicators, skipping AI check');
            return;
        }

        // --- AI SCORE (size-scaling, not hard gate) ---
        // The AI model earns veto power as it accumulates own-trade data (Phase B).
        // Until then, a model trained only on candle data is too pessimistic (predicts
        // loss for ~everything because ATR×4 TP is rarely hit in training windows).
        // Hard gates: quality score + HTF confluence + funding filter (below).
        const features = extractFeatures(
            signal.indicators,
            signal.price,
            (signal.indicators as any).currentVolume ?? (signal.indicators as any).volumeAvg ?? 0,
            isLong
        );

        const aiScore = aiLearning.getPrediction(features);
        logger.info(`🤖 AI Score (${dirLabel}): ${(aiScore * 100).toFixed(1)}% | Threshold: ${(baseThreshold * 100).toFixed(0)}%`);

        // AI size scaling: the 5% floor is the model's minimum output (not a real signal).
        // Only hard-block below 4% which is physically impossible from predictProbability().
        // Real gating is done by quality score + HTF + funding filters below.
        let aiSizeMultiplier = 1.0;
        if (aiScore < 0.04) {
            logger.warn(`❌ AI error state for ${symbol} (${(aiScore * 100).toFixed(1)}%) — skipping`);
            return;
        } else if (aiScore < baseThreshold) {
            aiSizeMultiplier = 0.8;
            logger.info(`⚠️ AI below threshold (${(aiScore * 100).toFixed(1)}%) — trading with 80% size`);
        } else if (aiScore > 0.75) {
            aiSizeMultiplier = 1.2;
            logger.info(`🚀 AI highly confident (${(aiScore * 100).toFixed(1)}%) — boosting size to 120%`);
        }

        // ─── 1. Funding Rate Filter ────────────────────────────────────────────
        // High positive funding = longs are overcrowded (paying shorts heavily).
        // Threshold 0.05% is ~5× the normal Bybit rate of ~0.01%.
        const bybitEx = this.exchange as any;
        let fundingRateValue: number | undefined;
        if (bybitEx.getFundingRate) {
            try {
                const funding: number | null = await bybitEx.getFundingRate(symbol);
                if (funding !== null) {
                    fundingRateValue = funding;
                    if (isLong && funding > 0.0005) {
                        logger.warn(`❌ Funding filter: ${symbol} funding ${(funding * 100).toFixed(4)}% > 0.05% — skipping LONG (longs overcrowded)`);
                        return;
                    }
                    if (isShort && funding < -0.0005) {
                        logger.warn(`❌ Funding filter: ${symbol} funding ${(funding * 100).toFixed(4)}% < -0.05% — skipping SHORT (shorts overcrowded)`);
                        return;
                    }
                    logger.info(`💰 Funding: ${symbol} ${(funding * 100).toFixed(4)}% — OK for ${dirLabel}`);
                }
            } catch (_) {}
        }

        // ─── 2. Fear & Greed Index ─────────────────────────────────────────────
        // Fetched early so it informs the regime threshold for the HTF check.
        let fngValue: number | undefined;
        let fngSizeMultiplier = 1.0;
        try {
            const fng = await getFearAndGreed();
            if (fng) {
                fngValue = fng.value;
                if (isLong && fng.value >= 90) {
                    logger.warn(`❌ Fear & Greed: ${fng.value} (${fng.label}) — skipping LONG (euphoric market)`);
                    return;
                }
                if (isLong && fng.value >= 80) {
                    fngSizeMultiplier = 0.7;
                    logger.info(`⚠️ Fear & Greed: ${fng.value} (${fng.label}) — LONG size reduced to 70%`);
                } else if (isShort && fng.value <= 20) {
                    fngSizeMultiplier = 0.7;
                    logger.info(`⚠️ Fear & Greed: ${fng.value} (${fng.label}) — SHORT size reduced to 70%`);
                } else {
                    logger.info(`😐 Fear & Greed: ${fng.value} (${fng.label}) — neutral`);
                }
            }
        } catch (_) {}

        // Regime-aware threshold: base + win-rate + F&G extreme + funding penalty
        const regimeThreshold = aiLearning.getConfidenceThreshold('futures', fundingRateValue, fngValue);
        if (regimeThreshold > baseThreshold) {
            logger.info(`🌡️ Regime threshold raised: ${(baseThreshold * 100).toFixed(0)}% → ${(regimeThreshold * 100).toFixed(0)}% (funding/sentiment adjustment)`);
        }

        // ─── 3. Higher-Timeframe Confluence ───────────────────────────────────
        // Against-trend: confidence penalty. With-trend: small boost.
        let htfAdj = 0;
        if (htfBullish1h !== null) {
            const aligned1h = (isLong && htfBullish1h) || (isShort && !htfBullish1h);
            htfAdj += aligned1h ? 0.05 : -0.15;
            logger.info(`${aligned1h ? '✅' : '⚠️'} HTF 1h: ${htfBullish1h ? 'BULL' : 'BEAR'} ${aligned1h ? 'aligns' : 'conflicts'} with ${dirLabel} (${aligned1h ? '+5%' : '-15%'})`);
        }
        if (htfBullish4h !== null) {
            const aligned4h = (isLong && htfBullish4h) || (isShort && !htfBullish4h);
            htfAdj += aligned4h ? 0.03 : -0.10;
            logger.info(`${aligned4h ? '✅' : '⚠️'} HTF 4h: ${htfBullish4h ? 'BULL' : 'BEAR'} ${aligned4h ? 'aligns' : 'conflicts'} with ${dirLabel} (${aligned4h ? '+3%' : '-10%'})`);
        }
        const adjustedConfidence = Math.max(0, Math.min(1, signal.confidence + htfAdj));
        if (adjustedConfidence < regimeThreshold) {
            logger.warn(`❌ HTF confluence: adjusted confidence ${(adjustedConfidence * 100).toFixed(1)}% < regime threshold ${(regimeThreshold * 100).toFixed(0)}% — skipping ${dirLabel} for ${symbol}`);
            return;
        }

        // ─── 3.5. Hard SHORT gate: require both HTF bearish ──────────────────
        // Shorts in uptrending markets are the main source of losses.
        // If either 1h or 4h HTF is bullish (confirmed data, not null), block the short.
        if (isShort && (htfBullish1h === true || htfBullish4h === true)) {
            logger.warn(`❌ SHORT blocked: macro not bearish (1h:${htfBullish1h} 4h:${htfBullish4h}) — skipping ${symbol}`);
            return;
        }

        // ─── 4. Trade Quality Score ───────────────────────────────────────────
        // Composite 0–100 score across HTF alignment, volume, MACD, funding.
        // Minimum 50/100 to enter (both HTF aligned = 50pts floor).
        const quality = this.computeQualityScore(
            isLong, htfBullish1h, htfBullish4h, fundingRateValue, signal.indicators
        );
        logger.info(`📊 Quality Score: ${quality.score}/100 | ${quality.breakdown}`);
        if (quality.score < 50) {
            logger.warn(`❌ Quality score ${quality.score}/100 < 50 — skipping ${dirLabel} for ${symbol}`);
            return;
        }

        // ─── 5. Open Interest Confirmation ────────────────────────────────────
        // Rising OI + long or falling OI + short = institutional confirmation.
        let oiSizeMultiplier = 1.0;
        if (bybitEx.getOpenInterestChange) {
            try {
                const oiChange: string = await bybitEx.getOpenInterestChange(symbol);
                const oiAligned = (isLong && oiChange === 'rising') || (isShort && oiChange === 'falling');
                const oiAgainst = (isLong && oiChange === 'falling') || (isShort && oiChange === 'rising');
                if (oiAligned) {
                    oiSizeMultiplier = 1.1;
                    logger.info(`✅ OI ${oiChange} confirms ${dirLabel} for ${symbol} — size +10%`);
                } else if (oiAgainst) {
                    oiSizeMultiplier = 0.85;
                    logger.info(`⚠️ OI ${oiChange} conflicts with ${dirLabel} for ${symbol} — size -15%`);
                }
            } catch (_) {}
        }

        logger.info(`🔍 Signal: ${dirLabel}, Conf: ${(signal.confidence * 100).toFixed(1)}% → HTF-adj: ${(adjustedConfidence * 100).toFixed(1)}%, Regime Threshold: ${(regimeThreshold * 100).toFixed(0)}%`);

        if (adjustedConfidence >= regimeThreshold) {
            // Check risk management
            const canOpen = await riskManager.canOpenPosition(symbol);
            logger.info(`🔍 Can Open Position? ${canOpen}`);
            if (!canOpen) return;

            // Get available balance
            const balance = await withRetry(
                () => this.exchange.fetchBalance(),
                'Fetch balance'
            );

            // Determine capital tier for this account size
            const tier = RiskManager.getTier(balance.free);

            // Calculate position size (margin-based, tier-based leverage applied inside)
            let positionSize = await riskManager.calculatePositionSize(
                symbol,
                signal.price,
                balance.free,
                this.exchange
            );

            // Apply learning adjustment, AI size multiplier, OI and F&G multipliers
            let adjustedAmount = positionSize.amount * riskMult * aiSizeMultiplier * oiSizeMultiplier * fngSizeMultiplier;
            const adjustedCost = adjustedAmount * signal.price;
            const minSize = Math.max(1, balance.free * 0.05);

            if (adjustedCost < minSize) {
                if (balance.free < minSize) {
                    logger.warn(`Insufficient balance ($${balance.free.toFixed(2)}) for minimum order size ($${minSize.toFixed(2)}). Skipping trade.`);
                    return;
                }
                adjustedAmount = (minSize * tier.leverage) / signal.price;
            }

            positionSize.amount = adjustedAmount;

            // Exchange minimum amount check
            try {
                const minExchangeAmount = await this.exchange.getMinOrderAmount(symbol);
                if (positionSize.amount < minExchangeAmount) {
                    logger.info(`Adjusting ${symbol} amount from ${positionSize.amount.toFixed(6)} up to exchange min ${minExchangeAmount}`);
                    positionSize.amount = minExchangeAmount;
                }
            } catch (e) {
                logger.warn(`Failed to check min exchange amount for ${symbol}: ${e}`);
            }

            // ATR DYNAMIC SL/TP — direction-aware
            if (signal.indicators.atr) {
                const atr = signal.indicators.atr;
                const slDist = atr * (config.strategy.atrMultiplierSL || 2.0);
                const tpDist = atr * (config.strategy.atrMultiplierTP || 3.0);

                if (isLong) {
                    positionSize.stopLoss = signal.price - slDist;    // SL below entry
                    positionSize.takeProfit = signal.price + tpDist;  // TP above entry
                } else {
                    positionSize.stopLoss = signal.price + slDist;    // SL above entry (SHORT loses if price rises)
                    positionSize.takeProfit = signal.price - tpDist;  // TP below entry (SHORT profits if price falls)
                }

                logger.info(`📏 ATR SL/TP for ${dirLabel}: SL=$${positionSize.stopLoss.toFixed(2)}, TP=$${positionSize.takeProfit.toFixed(2)}`);
            }

            try {
                if (positionSize.amount <= 0) {
                    logger.error(`❌ [FUTURES] Aborting ${dirLabel} trade for ${symbol}: Calculated amount is ${positionSize.amount}`);
                    return;
                }

                const leverage = tier.leverage; // Tier-based leverage
                const marginMode = config.futures.marginMode;

                // Set margin mode and leverage BEFORE placing order
                await this.exchange.setMarginMode(symbol, marginMode);
                await this.exchange.setLeverage(symbol, leverage);

                tradeLogger.info(
                    `🟢 [FUTURES] Opening ${dirLabel} position: ${symbol} | Amount: ${positionSize.amount.toFixed(6)} | Notional: $${(positionSize.amount * signal.price).toFixed(2)} @$${signal.price.toFixed(2)} | ${leverage}x ${marginMode}`
                );

                // Open LONG or SHORT
                let order;
                if (isLong) {
                    order = await this.exchange.createMarketBuyOrder(
                        symbol,
                        positionSize.amount,
                        positionSize.stopLoss,
                        positionSize.takeProfit
                    );
                } else {
                    order = await this.exchange.createMarketSellOrder(
                        symbol,
                        positionSize.amount,
                        positionSize.stopLoss,
                        positionSize.takeProfit
                    );
                }

                // Save trade to database — include AI feature snapshot for own-trade training
                const trade = await tradeRepository.createTrade({
                    exchange: this.exchange.getName(),
                    symbol,
                    side,
                    type: 'market',
                    amount: order.amount,
                    price: order.price,
                    cost: order.cost,
                    fee: typeof (order.fee as any) === 'object' ? ((order.fee as any)?.cost ?? 0) : (order.fee ?? 0),
                    entryPrice: order.price,
                    strategy: this.strategy.getName(),
                    signal: signal.signal,
                    confidence: signal.confidence,
                    marketType: 'futures',
                    leverage,
                    entryFeatures: JSON.stringify(features),
                });

                // Re-check in-memory map right before committing — DB check above may be stale
                if (this.positions.size >= config.risk.maxOpenPositions) {
                    logger.warn(`⚠️ Race guard: max positions reached — cancelling ${dirLabel} for ${symbol}`);
                    return;
                }

                // Add to positions map
                this.positions.set(symbol, {
                    tradeId: trade.id,
                    symbol,
                    side,
                    entryPrice: order.price,
                    amount: order.amount,
                    stopLoss: positionSize.stopLoss,
                    takeProfit: positionSize.takeProfit,
                    strategy: this.strategy.getName(),
                    leverage,
                    openedAt: Date.now(),
                    highestPrice: order.price, // LONG: tracks highest; SHORT: tracks lowest
                    partialExitDone: false,
                });

                // Reset loss cooldown on successful entry
                this.consecutiveLosses.set(symbol, 0);

                await notifier.notifyTrade({
                    symbol,
                    side,
                    price: order.price,
                    amount: order.amount,
                    cost: order.cost,
                });

                tradeLogger.info(`✅ ${dirLabel} position opened: ${symbol}`);
                webServer.pushLog(`🟢 ${dirLabel} opened: ${symbol} @ $${order.price.toFixed(4)} | ${leverage}x`, 'info');
                this.broadcastPositions();
            } catch (error) {
                logger.error(`Failed to open ${dirLabel} position for ${symbol}:`, error);
                await notifier.notifyError(`Failed to open ${dirLabel} position for ${symbol}: ${error}`);
            }
        }
    }


    /**
     * Manage existing position — supports LONG and SHORT for futures
     */
    private async managePosition(
        symbol: string,
        position: Position,
        signal: TradeSignal
    ): Promise<void> {
        const currentPrice = signal.price;
        const isShort = position.side === 'sell';
        const dirLabel = isShort ? 'SHORT' : 'LONG';

        // ─── 1. Update best-price tracking ───
        // LONG: track highest price; SHORT: track lowest price (stored in same field)
        if (!isShort && currentPrice > position.highestPrice) {
            position.highestPrice = currentPrice;
        } else if (isShort && currentPrice < position.highestPrice) {
            position.highestPrice = currentPrice; // lowest for short
        }

        // Direction-aware profit calculation
        const profitPct = isShort
            ? ((position.entryPrice - currentPrice) / position.entryPrice) * 100
            : ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        // ─── 1.5. Partial Take-Profit: close 50% at ATR×SL multiplier distance ───
        // Halfway to full TP (ATR×2 of ATR×4 full TP) — locks partial profit and moves SL to breakeven.
        if (!position.partialExitDone && (signal.indicators as any)?.atr) {
            const atr = (signal.indicators as any).atr as number;
            const partialTriggerDist = atr * (config.strategy.atrMultiplierSL || 2.0);
            const profitDist = isShort
                ? position.entryPrice - currentPrice
                : currentPrice - position.entryPrice;

            if (profitDist >= partialTriggerDist) {
                await this.closePartialPosition(symbol, position, currentPrice);
                return; // SL + partialExitDone already updated inside closePartialPosition
            }
        }

        // ─── 2. Breakeven stop: move SL to entry when profit >= breakEvenActivation% ───
        if (profitPct >= config.strategy.breakEvenActivation) {
            if (!isShort) {
                const breakEvenSL = position.entryPrice * 1.001;
                if (position.stopLoss < breakEvenSL) {
                    logger.info(`📈 [${symbol}][${dirLabel}] Moving SL to breakeven: $${position.stopLoss.toFixed(2)} → $${breakEvenSL.toFixed(2)} (profit: +${profitPct.toFixed(2)}%)`);
                    position.stopLoss = breakEvenSL;
                }
            } else {
                // SHORT: move SL down to just above entry
                const breakEvenSL = position.entryPrice * 0.999;
                if (position.stopLoss > breakEvenSL) {
                    logger.info(`📈 [${symbol}][${dirLabel}] Moving SL to breakeven: $${position.stopLoss.toFixed(2)} → $${breakEvenSL.toFixed(2)} (profit: +${profitPct.toFixed(2)}%)`);
                    position.stopLoss = breakEvenSL;
                }
            }
        }

        // ─── 3. Trailing stop: trail behind best price when profit >= trailingStopActivation% ───
        if (profitPct >= config.strategy.trailingStopActivation) {
            const trailDistance = config.strategy.trailingStopDistance / 100;

            if (!isShort) {
                // LONG: trail below highest price
                const trailingStopPrice = position.highestPrice * (1 - trailDistance);
                if (trailingStopPrice > position.stopLoss) {
                    logger.info(`📈 [${symbol}][${dirLabel}] Trailing stop: $${position.stopLoss.toFixed(2)} → $${trailingStopPrice.toFixed(2)} (high: $${position.highestPrice.toFixed(2)}, profit: +${profitPct.toFixed(2)}%)`);
                    position.stopLoss = trailingStopPrice;
                }
            } else {
                // SHORT: trail above lowest price
                const trailingStopPrice = position.highestPrice * (1 + trailDistance);
                if (trailingStopPrice < position.stopLoss) {
                    logger.info(`📈 [${symbol}][${dirLabel}] Trailing stop: $${position.stopLoss.toFixed(2)} → $${trailingStopPrice.toFixed(2)} (low: $${position.highestPrice.toFixed(2)}, profit: +${profitPct.toFixed(2)}%)`);
                    position.stopLoss = trailingStopPrice;
                }
            }
        }

        // ─── 4. Smart Profit-Taking: Exit on reversal after reaching target ───
        const smartMin = (config.strategy as any).smartTakeProfitMin || 1.0;
        const smartPullback = (config.strategy as any).smartTakeProfitPullback || 0.3;

        if (profitPct >= smartMin) {
            if (!isShort) {
                const pullbackFromHigh = ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
                if (pullbackFromHigh >= smartPullback) {
                    logger.info(`💰 [${symbol}][${dirLabel}] Smart Profit-Taking: +${profitPct.toFixed(2)}%, pullback ${pullbackFromHigh.toFixed(2)}% from high — closing`);
                    await this.closePosition(symbol, position, currentPrice, `Smart Profit-Taking (+${profitPct.toFixed(2)}%)`);
                    return;
                }
            } else {
                // SHORT: exit if price bounces up from the lowest point reached
                const bounceFromLow = ((currentPrice - position.highestPrice) / position.highestPrice) * 100;
                if (bounceFromLow >= smartPullback) {
                    logger.info(`💰 [${symbol}][${dirLabel}] Smart Profit-Taking: +${profitPct.toFixed(2)}%, bounce ${bounceFromLow.toFixed(2)}% from low — closing`);
                    await this.closePosition(symbol, position, currentPrice, `Smart Profit-Taking (+${profitPct.toFixed(2)}%)`);
                    return;
                }
            }
        }

        // ─── 5. Time-based stale position exit ───
        const hoursOpen = (Date.now() - position.openedAt) / (1000 * 60 * 60);
        if (hoursOpen >= config.strategy.stalePositionHours && profitPct < config.strategy.stalePositionMinProfit) {
            logger.info(`⏰ [${symbol}][${dirLabel}] Stale position: open ${hoursOpen.toFixed(1)}h with only ${profitPct.toFixed(2)}% profit — closing`);
            await this.closePosition(symbol, position, currentPrice, `Stale position (${hoursOpen.toFixed(1)}h, +${profitPct.toFixed(2)}%)`);
            return;
        }

        // ─── 6. Check stop loss and take profit (direction-aware) ───
        const { shouldClose, reason } = riskManager.shouldClosePosition(
            currentPrice,
            position.stopLoss,
            position.takeProfit,
            position.side
        );

        // ─── 7. Strategy exit signal ───
        // LONG exits when strategy gives SHORT signal; SHORT exits when strategy gives LONG signal
        const strategyExit = position.amount > 0 && (
            (!isShort && signal.direction === 'short') ||
            (isShort && signal.direction === 'long')
        );

        if (shouldClose || strategyExit) {
            const closeReason = reason || signal.reason;

            // Detect trailing stop: SL was moved beyond entry in profitable direction
            const slBeyondEntry = !isShort
                ? position.stopLoss > position.entryPrice
                : position.stopLoss < position.entryPrice;

            if (reason === 'Stop loss hit' && slBeyondEntry) {
                const lockedPct = !isShort
                    ? ((position.stopLoss - position.entryPrice) / position.entryPrice * 100).toFixed(2)
                    : ((position.entryPrice - position.stopLoss) / position.entryPrice * 100).toFixed(2);
                await this.closePosition(symbol, position, currentPrice, `Trailing stop hit (locked +${lockedPct}% profit)`);
            } else {
                await this.closePosition(symbol, position, currentPrice, closeReason);
            }
        }
    }

    /**
     * Compute a 0–100 composite quality score for a trade setup.
     * Minimum 50/100 required to enter. Both HTF aligned = 50pts floor.
     */
    private computeQualityScore(
        isLong: boolean,
        htfBullish1h: boolean | null,
        htfBullish4h: boolean | null,
        fundingRate: number | undefined,
        indicators: any,
    ): { score: number; breakdown: string } {
        let score = 0;
        const parts: string[] = [];

        // HTF 1h alignment (25pts) — neutral 12pts when data unavailable
        if (htfBullish1h !== null) {
            const pts = ((isLong && htfBullish1h) || (!isLong && !htfBullish1h)) ? 25 : 0;
            score += pts;
            parts.push(`1h:${pts}`);
        } else {
            score += 12; // neutral — can't confirm or deny
            parts.push(`1h:12(n/a)`);
        }

        // HTF 4h alignment (25pts) — neutral 12pts when data unavailable
        if (htfBullish4h !== null) {
            const pts = ((isLong && htfBullish4h) || (!isLong && !htfBullish4h)) ? 25 : 0;
            score += pts;
            parts.push(`4h:${pts}`);
        } else {
            score += 12; // neutral
            parts.push(`4h:12(n/a)`);
        }

        // Volume surge (20pts)
        const volRatio = indicators.volumeAvg > 0
            ? (indicators.currentVolume || 0) / indicators.volumeAvg
            : 0;
        const volPts = volRatio >= 1.5 ? 20 : volRatio >= 1.2 ? 10 : 0;
        score += volPts;
        parts.push(`Vol:${volPts}`);

        // MACD momentum in trade direction (15pts)
        const hist = indicators.macd?.histogram || 0;
        const macdAligned = (isLong && hist > 0) || (!isLong && hist < 0);
        const macdPts = (macdAligned && Math.abs(hist) > 0) ? 15 : 0;
        score += macdPts;
        parts.push(`MACD:${macdPts}`);

        // Funding cost (15pts) — low funding = cheap to hold
        let fundPts = 10; // default if unknown
        if (fundingRate !== undefined) {
            const abs = Math.abs(fundingRate);
            fundPts = abs < 0.0002 ? 15 : abs < 0.0003 ? 7 : 0;
        }
        score += fundPts;
        parts.push(`Fund:${fundPts}`);

        return { score, breakdown: parts.join(' | ') };
    }

    /**
     * Close 50% of a position (partial take-profit), move SL to breakeven.
     * Updates position in-memory; the DB trade stays open until full close.
     */
    private async closePartialPosition(symbol: string, position: Position, currentPrice: number): Promise<void> {
        const isShort = position.side === 'sell';
        const dirLabel = isShort ? 'SHORT' : 'LONG';
        const halfAmount = position.amount / 2;

        try {
            let order;
            if (!isShort) {
                order = await this.exchange.createMarketSellOrder(symbol, halfAmount);
            } else {
                order = await this.exchange.createMarketBuyOrder(symbol, halfAmount);
            }

            const closePrice = (order.price && Number.isFinite(order.price)) ? order.price : currentPrice;
            const rawFee = order.fee;
            const feeAmount: number = rawFee == null ? 0
                : typeof rawFee === 'object' ? (Number((rawFee as any).cost) || 0)
                : Number(rawFee) || 0;

            const { pnl } = riskManager.calculatePnL(
                position.entryPrice, closePrice, halfAmount, feeAmount, position.side, position.leverage
            );

            // Update in-memory position: halve amount, mark done, tighten SL to breakeven
            position.amount = halfAmount;
            position.partialExitDone = true;
            if (!isShort) {
                position.stopLoss = Math.max(position.stopLoss, position.entryPrice * 1.001);
            } else {
                position.stopLoss = Math.min(position.stopLoss, position.entryPrice * 0.999);
            }

            const pnlStr = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
            logger.info(`💰 [${symbol}][${dirLabel}] Partial TP: Closed 50% @ $${closePrice.toFixed(4)} | P&L: ${pnlStr} | SL → breakeven`);
            await notifier.sendMessage(`💰 *Partial TP* — ${symbol} ${dirLabel}\n\n✅ Closed 50% @ $${closePrice.toFixed(4)}\nPartial P&L: ${pnlStr}\n📌 SL moved to breakeven\n⏳ Remaining 50% running to full TP`);
            webServer.pushLog(`💰 Partial TP: ${symbol} ${dirLabel} — ${pnlStr}`, 'info');
            this.broadcastPositions();
        } catch (error) {
            logger.error(`Failed partial close for ${symbol}:`, error);
            // Do not set partialExitDone — will retry on next cycle
        }
    }

    /**
     * Close a futures position (LONG or SHORT)
     */
    private async closePosition(
        symbol: string,
        position: Position,
        exitPrice: number,
        reason: string
    ): Promise<void> {
        try {
            const isShort = position.side === 'sell';
            const dirLabel = isShort ? 'SHORT' : 'LONG';

            tradeLogger.info(
                `🔴 Closing ${dirLabel} position: ${symbol} @$${exitPrice.toFixed(2)} (${reason})`
            );

            // For futures contracts: position size is in contracts, not base currency held in wallet
            // We close using the exact tracked amount (no wallet balance check needed for futures)
            let amountToClose = position.amount;

            if (amountToClose <= 0) {
                logger.warn(`⚠️ [GHOST] Cannot close ${dirLabel} position for ${symbol}: amount is 0. Marking as closed in database.`);

                await tradeRepository.updateTrade(position.tradeId, {
                    exitPrice,
                    exitTime: new Date(),
                    realizedPnl: 0,
                    pnlPercentage: 0,
                    status: 'closed',
                });

                this.positions.delete(symbol);
                return;
            }

            // DUST CHECK: Don't try to send orders below exchange limits
            const currentPrice = exitPrice;
            const orderValue = amountToClose * currentPrice;
            const minOrderValue = (this.exchange as any).getMinOrderValue ? await (this.exchange as any).getMinOrderValue(symbol) : 1.0;

            if (orderValue < minOrderValue) {
                tradeLogger.warn(`⚠️ [DUST] Current value of ${symbol} ($${orderValue.toFixed(4)}) < Min Order Value ($${minOrderValue}). Skipping exchange order but marking closed.`);

                await tradeRepository.updateTrade(position.tradeId, {
                    exitPrice: currentPrice,
                    exitTime: new Date(),
                    realizedPnl: 0,
                    pnlPercentage: 0,
                    status: 'closed',
                });

                this.positions.delete(symbol);
                return;
            }

            logger.info(`🔍 Closing ${dirLabel} ${symbol}: tracked size ${position.amount}, closing ${amountToClose}`);

            // Execute closure order
            // LONG close: sell contracts; SHORT close: buy contracts
            let order;
            try {
                if (!isShort) {
                    order = await this.exchange.createMarketSellOrder(symbol, amountToClose);
                } else {
                    order = await this.exchange.createMarketBuyOrder(symbol, amountToClose);
                }
            } catch (closeError: any) {
                // Retry with 99% if exchange rejects due to precision/rounding
                if (closeError.message && (closeError.message.includes('170131') || closeError.message.includes('Insufficient') || closeError.message.includes('reduce-only'))) {
                    const retryAmount = amountToClose * 0.99;
                    logger.warn(`Close failed. Retrying with 99% of amount (${retryAmount})...`);
                    if (!isShort) {
                        order = await this.exchange.createMarketSellOrder(symbol, retryAmount);
                    } else {
                        order = await this.exchange.createMarketBuyOrder(symbol, retryAmount);
                    }
                } else {
                    throw closeError;
                }
            }

            // Normalize fee: paper mode returns { cost, currency } object; live returns number
            const rawFee = order.fee;
            const feeAmount: number = rawFee == null ? 0
                : typeof rawFee === 'object' ? (Number((rawFee as any).cost) || 0)
                : Number(rawFee) || 0;

            // Ensure we have a valid fill price (fall back to the intended exitPrice)
            const closePrice = (order.price && Number.isFinite(order.price)) ? order.price : exitPrice;

            // Calculate P&L — leverage and direction-aware
            const { pnl: rawPnl, pnlPercentage: rawPnlPct } = riskManager.calculatePnL(
                position.entryPrice,
                closePrice,
                order.amount,
                feeAmount,
                position.side,
                position.leverage
            );

            // Guard: never persist NaN/Infinity to DB
            const pnl = Number.isFinite(rawPnl) ? rawPnl : 0;
            const pnlPercentage = Number.isFinite(rawPnlPct) ? rawPnlPct : 0;

            // Update trade in database
            await tradeRepository.updateTrade(position.tradeId, {
                exitPrice: closePrice,
                exitTime: new Date(),
                realizedPnl: pnl,
                pnlPercentage,
                status: 'closed',
            });

            // Remove from positions
            this.positions.delete(symbol);

            // ─── Track consecutive losses for cooldown ───
            if (pnl < 0) {
                const losses = (this.consecutiveLosses.get(symbol) || 0) + 1;
                this.consecutiveLosses.set(symbol, losses);

                if (losses >= config.strategy.consecutiveLossCooldown) {
                    logger.warn(`🛑 [${symbol}] ${losses} consecutive losses — entering cooldown for ${config.strategy.cooldownCycles} cycles`);
                    this.cooldownRemaining.set(symbol, config.strategy.cooldownCycles);
                    this.consecutiveLosses.set(symbol, 0); // Reset counter
                }
            } else {
                // Reset on any win
                this.consecutiveLosses.set(symbol, 0);
            }

            // Notify
            await notifier.notifyPositionClosed({
                symbol,
                side: position.side,
                entryPrice: position.entryPrice,
                exitPrice: closePrice,
                pnl,
                pnlPercentage,
            });

            tradeLogger.info(
                `✅ Position closed: ${symbol} | P & L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPercentage.toFixed(2)}%) | Reason: ${reason}`
            );
            webServer.pushLog(
                `${pnl >= 0 ? '💰' : '📉'} ${dirLabel} closed: ${symbol} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercentage.toFixed(2)}%) | ${reason}`,
                pnl >= 0 ? 'info' : 'warn'
            );
            this.broadcastPositions();
        } catch (error) {
            logger.error(`Failed to close position for ${symbol}: `, error);
            await notifier.notifyError(`Failed to close position for ${symbol}: ${error} `);
        }
    }

    private broadcastPositions() {
        const positionsArr = Array.from(this.positions.values());
        webServer.broadcast('positions', positionsArr);
    }

    async getStatus(): Promise<{
        isRunning: boolean;
        openPositions: number;
        positionDetails: Array<{ symbol: string; side: string; entryPrice: number; currentPrice: number | null; pnlPct: number; unrealizedPnl: number }>;
        monitoredPairs: string[];
        dailyPnL: number;
        totalPnL: number;
        unrealizedPnL: number;
        recentWinRate: number;
        lifetimeWinRate: number;
        walletBalances: Map<string, number>;
        readiness: {
            score: number;
            thresholds: {
                trades:       { value: number;  target: number; pass: boolean };
                winRate:      { value: number;  target: number; pass: boolean };
                profitable:   { value: number;  target: number; pass: boolean };
                modelTrained: { value: number;  target: number; pass: boolean };
                modelFresh:   { value: number;  target: number; pass: boolean };
                dailyHealth:  { value: number;  target: number; pass: boolean };
            };
        };
    }> {
        const dailyPnL = await tradeRepository.getDailyPnL(new Date(), 'futures');
        const totalPnL = await tradeRepository.getTotalPnL('futures');
        const lifetimeWinRate = await tradeRepository.getLifetimeWinRate('futures');
        const recentWinRate = aiLearning.getWinRate('futures');

        const monitoredPairs = this.activePairs;

        // Collect position details with live price and unrealized P&L
        const positionDetails: Array<{ symbol: string; side: string; entryPrice: number; currentPrice: number | null; pnlPct: number; unrealizedPnl: number }> = [];
        for (const [sym, pos] of this.positions.entries()) {
            let currentPrice: number | null = null;
            let pnlPct = 0;
            let unrealizedPnl = 0;
            try {
                const ticker = await this.exchange.fetchTicker(sym);
                currentPrice = ticker.last;
                if (currentPrice && pos.entryPrice > 0) {
                    const priceDiff = pos.side === 'buy'
                        ? (currentPrice - pos.entryPrice) / pos.entryPrice
                        : (pos.entryPrice - currentPrice) / pos.entryPrice;
                    pnlPct = priceDiff * 100 * pos.leverage;
                    // Approximate unrealized P&L in USDT (entry notional * raw % move * leverage)
                    unrealizedPnl = pos.entryPrice * pos.amount * priceDiff * pos.leverage;
                }
            } catch (_) { /* non-fatal — show entry price only */ }
            positionDetails.push({
                symbol: sym,
                side: pos.side,
                entryPrice: pos.entryPrice,
                currentPrice,
                pnlPct,
                unrealizedPnl,
            });
        }

        const walletBalances = new Map<string, number>();

        if (config.mode === 'paper') {
            // Paper mode: initial capital ± realized P&L (live exchange balance is not used)
            const paperInitial = parseFloat(process.env.PAPER_INITIAL_BALANCE || '10000');
            walletBalances.set('USDT', paperInitial + totalPnL);
        } else {
            // Live mode: fetch real balances for all relevant currencies
            const positionPairs = Array.from(this.positions.keys());
            const allPairsForBalance = [...new Set([...positionPairs, ...monitoredPairs])];

            for (const pair of allPairsForBalance) {
                try {
                    const baseCurrency = pair.split('/')[0];
                    if (walletBalances.has(baseCurrency)) continue;
                    const balance = await this.exchange.fetchBalance(baseCurrency);
                    walletBalances.set(baseCurrency, balance.free);
                } catch (e) {
                    logger.warn(`Failed to fetch balance for ${pair}: ${e}`);
                }
            }

            // Also get quote currency balance (USDT)
            try {
                const allPairsForBalance2 = [...new Set([...Array.from(this.positions.keys()), ...monitoredPairs])];
                const rawQuote = allPairsForBalance2[0]?.split('/')[1] || 'USDT';
                const quoteCurrency = rawQuote.split(':')[0];
                const balance = await this.exchange.fetchBalance(quoteCurrency);
                walletBalances.set(quoteCurrency, balance.free);
            } catch (e) {
                logger.warn(`Failed to fetch quote balance: ${e}`);
            }
        }

        const unrealizedPnL = positionDetails.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

        // ─── Live Readiness ────────────────────────────────────────────────────
        const closedTradeCount = await tradeRepository.getClosedTradeCount('futures');
        const retrainerStatus = autoRetrainer.getStatus();
        const modelAge = retrainerStatus.lastRetrain
            ? Math.round((Date.now() - new Date(retrainerStatus.lastRetrain).getTime()) / 3600000)
            : 9999;

        const readinessThresholds = {
            trades:       { value: closedTradeCount,  target: 30, pass: closedTradeCount >= 30 },
            winRate:      { value: lifetimeWinRate,   target: 55, pass: lifetimeWinRate >= 55 },
            profitable:   { value: totalPnL,          target: 0,  pass: totalPnL > 0 },
            modelTrained: { value: retrainerStatus.lastRetrain ? 1 : 0, target: 1, pass: !!retrainerStatus.lastRetrain },
            modelFresh:   { value: modelAge,          target: 48, pass: modelAge < 48 },
            dailyHealth:  { value: dailyPnL,          target: 0,  pass: dailyPnL >= 0 },
        };
        const passCount = Object.values(readinessThresholds).filter(t => t.pass).length;
        const readinessScore = Math.round((passCount / Object.keys(readinessThresholds).length) * 100);

        return {
            isRunning: this.isRunning,
            openPositions: this.positions.size,
            positionDetails,
            monitoredPairs,
            dailyPnL,
            totalPnL,
            unrealizedPnL,
            recentWinRate,
            lifetimeWinRate,
            walletBalances,
            readiness: { score: readinessScore, thresholds: readinessThresholds },
        };
    }

    /**
     * Add a trading pair dynamically
     */
    async addPair(symbol: string): Promise<string> {
        if (this.activePairs.includes(symbol)) {
            return `⚠️ ${symbol} is already being monitored.`;
        }

        // Add to active list
        this.activePairs.push(symbol);

        // Start monitoring if engine is running
        if (this.isRunning) {
            this.processSymbol(symbol);
            return `✅ Started monitoring ${symbol}.`;
        }

        return `✅ Added ${symbol} to monitoring list (Bot is currently stopped).`;
    }

    /**
     * Remove a trading pair dynamically
     */
    async removePair(symbol: string): Promise<string> {
        const index = this.activePairs.indexOf(symbol);

        if (index === -1) {
            return `⚠️ ${symbol} is not in the monitored list.`;
        }

        // Remove from list
        this.activePairs.splice(index, 1);

        // Stop monitoring interval
        const interval = this.marketDataIntervals.get(symbol);
        if (interval) {
            clearTimeout(interval);
            this.marketDataIntervals.delete(symbol);
            return `✅ Stopped monitoring ${symbol}.`;
        }

        return `✅ Removed ${symbol} from potential pairs list.`;
    }

    /**
     * Get market analysis for a specific symbol
     */
    async getMarketAnalysis(symbol: string): Promise<any> {
        try {
            const candles = await this.exchange.fetchOHLCV(symbol, config.timeframe, 100);
            if (candles.length < 50) return { error: 'Insufficient data' };

            const indicators = IndicatorCalculator.calculate(candles);
            if (!indicators) return { error: 'Failed to calculate indicators' };

            const analysis = this.strategy.analyze(candles, indicators);
            return {
                symbol,
                price: analysis.price,
                signal: analysis.signal,
                confidence: analysis.confidence,
                reason: analysis.reason,
                indicators: {
                    rsi: indicators.rsi,
                    macd: indicators.macd,
                    ema9: indicators.ema9,
                    ema21: indicators.ema21
                }
            };
        } catch (error) {
            logger.error(`Error analyzing ${symbol}:`, error);
            return { error: 'Analysis failed' };
        }
    }


    /**
     * Update minimum position size
     */
    async updateMinPositionSize(newSize: number): Promise<string> {
        config.risk.minPositionSize = newSize;
        logger.info(`⚙️ [FUTURES] Minimum position size updated to $${newSize}`);
        return `✅ [FUTURES] Minimum position size updated to $${newSize}`;
    }

    /**
     * Get current minimum position size
     */
    getMinPositionSize(): number {
        return config.risk.minPositionSize;
    }

    /**
     * Get currently active trading pairs
     */
    getActivePairs(): string[] {
        return [...this.activePairs];
    }

    /**
     * Get scanner status for Telegram display
     */
    async getScannerStatus(): Promise<any> {
        if (!this.marketScanner) {
            return { pairs: [], activePairCount: 0, minutesSinceLastScan: -1 };
        }

        const cached = this.marketScanner.getCachedResults();
        const minutesSinceLastScan = this.marketScanner.getMinutesSinceLastScan();

        return {
            pairs: cached,
            activePairCount: config.scanner.maxActivePairs,
            minutesSinceLastScan,
        };
    }

    /**
     * Force an immediate market re-scan
     */
    async forceRescan(): Promise<string> {
        if (!this.marketScanner) {
            return '⚠️ MarketScanner is not active. Enable AUTO_PAIR_SELECTION in .env.';
        }

        try {
            await this.rescanPairs();
            return `✅ Re-scan complete. Active pairs: ${this.activePairs.join(', ')}`;
        } catch (err) {
            return `❌ Re-scan failed: ${err}`;
        }
    }
}
