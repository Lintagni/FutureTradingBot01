import { tradeRepository } from '../database/TradeRepository';
import { config } from '../config/trading.config';
import { logger } from '../utils/logger';
import { aiModel } from '../ai/RandomForestModel';

const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes cache

export interface LearningState {
    winRate: number;
    profitFactor: number;
    totalTrades: number;
    adjustmentFactor: number; // 0.5 to 1.5 (multiplies risk/confidence)
    marketRegime: 'bull' | 'bear' | 'ranging';
    lastLearnTime: number; // For caching
}

export class AdaptiveLearning {
    private static instance: AdaptiveLearning;
    private states: Map<string, LearningState> = new Map();

    private constructor() {
        // Initialize default states
        this.states.set('spot', this.getInitialState());

        // Load AI model on startup
        const loaded = aiModel.load();
        if (loaded) {
            logger.info('🧠 AI Model loaded into AdaptiveLearning');
        } else {
            logger.warn('🧠 AI Model not found. Will use heuristics only until trained.');
        }
    }

    private getInitialState(): LearningState {
        return {
            winRate: 0,
            profitFactor: 0,
            totalTrades: 0,
            adjustmentFactor: 1.0,
            marketRegime: 'ranging',
            lastLearnTime: 0,
        };
    }

    private getState(marketType: string): LearningState {
        if (!this.states.has(marketType)) {
            this.states.set(marketType, this.getInitialState());
        }
        return this.states.get(marketType)!;
    }

    static getInstance(): AdaptiveLearning {
        if (!AdaptiveLearning.instance) {
            AdaptiveLearning.instance = new AdaptiveLearning();
        }
        return AdaptiveLearning.instance;
    }

    /**
     * Get AI Prediction for trade success
     * @param features Array of calculated features
     * @returns Probability of success (0-1)
     */
    getPrediction(features: number[]): number {
        const prediction = aiModel.predictProbability(features);
        logger.debug(`🧠 AI Prediction Trace: features=[${features.map(f => f.toFixed(2)).join(', ')}] → prob=${(prediction * 100).toFixed(1)}%`);
        return prediction;
    }

    /**
     * Analyze recent performance and update internal state
     */
    async learn(marketType: string = 'spot', force: boolean = false): Promise<void> {
        try {
            const state = this.getState(marketType);
            const now = Date.now();

            if (!force && now - state.lastLearnTime < CACHE_DURATION) {
                // logger.debug(`🧠 [${marketType.toUpperCase()}] Using cached learning state (Valid for ${((CACHE_DURATION - (now - state.lastLearnTime)) / 60000).toFixed(1)} mins)`);
                return;
            }

            logger.info(`🧠 [${marketType.toUpperCase()}] Starting learning phase (Cache expired or forced)...`);
            // Get last 20 trades for this specific market type
            const allTrades = await tradeRepository.getRecentTrades(20, marketType);

            logger.info(`🧠 [${marketType.toUpperCase()}] Found ${allTrades.length} recent trades (any status)`);

            // Only consider CLOSED trades for learning statistics
            const closedTrades = allTrades.filter((t: any) => t.status === 'closed');

            // Log status
            logger.info(`🧠 [${marketType.toUpperCase()}] Learning Status: ${closedTrades.length} closed trades found (Threshold: 3)`);

            if (closedTrades.length < 3) {
                logger.info(`🧠 [${marketType.toUpperCase()}] Not enough closed trades to learn yet (need 3+, have ${closedTrades.length})`);
                return;
            }

            // Filter out trades with 0 PnL (bugged trades) to avoid skewing stats
            const validTrades = closedTrades.filter((t: any) => t.realizedPnl !== 0);

            if (validTrades.length === 0) {
                logger.info(`🧠 [${marketType.toUpperCase()}] Found closed trades but all have 0 PnL. Waiting for new data.`);
                return;
            }

            // Calculate Win Rate
            const wins = validTrades.filter((t: any) => t.realizedPnl && t.realizedPnl > 0).length;

            // Calculate Profit Factor (Gross Profit / Gross Loss)
            const grossProfit = validTrades
                .filter((t: any) => t.realizedPnl && t.realizedPnl > 0)
                .reduce((sum: number, t: any) => sum + (t.realizedPnl || 0), 0);

            const grossLoss = validTrades
                .filter((t: any) => t.realizedPnl && t.realizedPnl < 0)
                .reduce((sum: number, t: any) => sum + Math.abs(t.realizedPnl || 0), 0);

            // ADJUSTMENT LOGIC
            state.winRate = (wins / validTrades.length) * 100;
            state.totalTrades = validTrades.length;
            state.profitFactor = grossLoss === 0 ? grossProfit : grossProfit / grossLoss;

            if (state.winRate > 60) {
                state.adjustmentFactor = 1.2;
                logger.info(`🧠 [${marketType.toUpperCase()}] Learning: Strategy working well (WR: ${state.winRate.toFixed(1)}%). Increasing aggression.`);
            } else if (state.winRate < 40) {
                state.adjustmentFactor = 0.8;
                logger.info(`🧠 [${marketType.toUpperCase()}] Learning: Strategy struggling (WR: ${state.winRate.toFixed(1)}%). Reducing risk.`);
            } else {
                state.adjustmentFactor = 1.0;
                logger.info(`🧠 [${marketType.toUpperCase()}] Learning: Strategy Neutral (WR: ${state.winRate.toFixed(1)}%)`);
            }

            state.lastLearnTime = Date.now();

        } catch (error) {
            logger.error(`Error in [${marketType}] learning module:`, error);
        }
    }

    /**
     * Get the current risk multiplier based on learning
     */
    getRiskMultiplier(marketType: string = 'spot'): number {
        return this.getState(marketType).adjustmentFactor;
    }

    /**
     * Get the regime-aware confidence threshold.
     * Base = config threshold. Additively raised by win-rate, Fear&Greed extremes, and high funding.
     * Capped at 0.75 to prevent the bot from being permanently blocked.
     */
    getConfidenceThreshold(_marketType: string = 'spot', fundingRate?: number, fearGreed?: number): number {
        let threshold = config.strategy.mlConfidenceThreshold || 0.55;
        const state = this.getState(_marketType);

        // Poor win rate penalty
        if (state.totalTrades >= 10 && state.winRate < 40) {
            threshold += 0.10;
        }
        // Extreme market sentiment penalty (euphoria or panic increases risk)
        if (fearGreed !== undefined && (fearGreed < 20 || fearGreed > 80)) {
            threshold += 0.10;
        }
        // High funding rate penalty (overcrowded direction — costly to hold)
        if (fundingRate !== undefined && Math.abs(fundingRate) > 0.0003) {
            threshold += 0.05;
        }

        return Math.min(threshold, 0.75);
    }

    /**
     * Get the current Win Rate (recent window)
     */
    getWinRate(marketType: string = 'spot'): number {
        return this.getState(marketType).winRate;
    }
}

export const aiLearning = AdaptiveLearning.getInstance();

/**
 * Extract features for AI model
 * [RSI, MACD_Hist, Price/EMA21, Price/EMA9, Volume/AvgVolume, BandWidth, ADX, isLong]
 */
export function extractFeatures(
    indicators: any,
    currentPrice: number,
    currentVolume: number,
    isLong: boolean = true
): number[] {
    const safeDiv = (n: number, d: number) => (d === 0 || !d ? 0 : n / d);

    const adxNum = typeof indicators.adx === 'object' ? (indicators.adx as any)?.adx ?? 25 : indicators.adx ?? 25;

    // Candle body strength: where close sits in the high-low range
    const high  = indicators.high  ?? currentPrice;
    const low   = indicators.low   ?? currentPrice;
    const range = high - low;
    const bodyStrength = range > 0 ? (currentPrice - low) / range : 0.5;

    const rawFeatures = [
        indicators.rsi || 50,
        indicators.macd?.histogram || 0,
        safeDiv(currentPrice, indicators.ema21),
        safeDiv(currentPrice, indicators.ema9),
        safeDiv(currentVolume, indicators.volumeAvg),
        safeDiv((indicators.bb?.upper - indicators.bb?.lower), indicators.bb?.middle),
        adxNum,
        bodyStrength,      // feature #7 — matches training
        isLong ? 1.0 : 0.0,
    ];

    return rawFeatures.map(v => (Number.isFinite(v) ? v : 0));
}
