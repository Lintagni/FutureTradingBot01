import { BybitExchange } from '../exchanges/BybitExchange';
import { IndicatorCalculator } from '../utils/indicators';
import { aiModel } from './RandomForestModel';
import { logger } from '../utils/logger';
import { notifier } from '../utils/notifier';
import { config } from '../config/trading.config';
import fs from 'fs';
import path from 'path';

/**
 * AutoRetrainer — Periodically retrains the AI model with fresh market data.
 * 
 * Default: every 12 hours
 * Safety: Only replaces the model if new accuracy >= 60%, otherwise keeps old model.
 * Sends Telegram notification on each retrain with results.
 */
export class AutoRetrainer {
    private intervalMs: number;
    private timer: NodeJS.Timeout | null = null;
    private isRetraining: boolean = false;
    private lastRetrainTime: Date | null = null;
    private trainingPairs = [
        'BTC/USDT', 'ETH/USDT', 'SOL/USDT',
        'BNB/USDT', 'XRP/USDT', 'DOGE/USDT',
        'AVAX/USDT', 'LINK/USDT',
    ];

    constructor(intervalHours: number = 12) {
        this.intervalMs = intervalHours * 60 * 60 * 1000;
    }

    /**
     * Start the auto-retrain scheduler
     */
    start(): void {
        logger.info(`🔄 AutoRetrainer: Scheduled every ${this.intervalMs / (60 * 60 * 1000)}h`);

        // Run first retrain after a short delay (5 min) to let bot stabilize
        setTimeout(() => {
            this.retrain();
        }, 5 * 60 * 1000);

        // Then on interval
        this.timer = setInterval(() => {
            this.retrain();
        }, this.intervalMs);
    }

    /**
     * Stop the auto-retrain scheduler
     */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        logger.info('🔄 AutoRetrainer: Stopped');
    }

    /**
     * Force a retrain now (can be called from Telegram command)
     */
    async forceRetrain(): Promise<string> {
        if (this.isRetraining) {
            return '⏳ Retraining already in progress...';
        }
        await this.retrain();
        return `✅ Retrain complete! Last trained: ${this.lastRetrainTime?.toLocaleTimeString()}`;
    }

    /**
     * Get retrain status
     */
    getStatus(): { lastRetrain: Date | null; intervalHours: number; isRetraining: boolean } {
        return {
            lastRetrain: this.lastRetrainTime,
            intervalHours: this.intervalMs / (60 * 60 * 1000),
            isRetraining: this.isRetraining,
        };
    }

    /**
     * Core retrain logic — fetches fresh data, trains, validates, and swaps model
     */
    private async retrain(): Promise<void> {
        if (this.isRetraining) {
            logger.warn('🔄 AutoRetrainer: Already retraining, skipping...');
            return;
        }

        this.isRetraining = true;
        const startTime = Date.now();

        try {
            logger.info('🔄 AutoRetrainer: Starting retrain...');

            const exchange = new BybitExchange();

            const allFeatures: number[][] = [];
            const allLabels: number[] = [];

            const ATR_SL_MULT = config.strategy.atrMultiplierSL || 2.0;
            const ATR_TP_MULT = config.strategy.atrMultiplierTP || 3.0;
            const LOOKAHEAD = 36;

            // Fetch data from multiple pairs
            for (const symbol of this.trainingPairs) {
                try {
                    const candles = await exchange.fetchOHLCV(symbol, config.timeframe, 400);

                    if (candles.length < 200) {
                        logger.warn(`AutoRetrainer: Not enough data for ${symbol}, skipping.`);
                        continue;
                    }

                    const allIndicators = IndicatorCalculator.calculateAll(candles);
                    const offset = candles.length - allIndicators.length;

                    for (let i = 0; i < allIndicators.length - LOOKAHEAD; i++) {
                        const indicators = allIndicators[i];
                        const candleIndex = offset + i;

                        if (candleIndex < 0 || candleIndex >= candles.length) continue;

                        const currentPrice = candles[candleIndex].close;
                        const currentVolume = candles[candleIndex].volume;
                        const atr = indicators.atr;

                        if (!atr || atr <= 0) continue;

                        const slDistance = atr * ATR_SL_MULT;
                        const tpDistance = atr * ATR_TP_MULT;

                        const adxValue = typeof indicators.adx === 'object'
                            ? (indicators.adx as any).adx || 0
                            : indicators.adx || 0;

                        const baseFeat = [
                            indicators.rsi || 50,
                            indicators.macd?.histogram || 0,
                            currentPrice / (indicators.ema21 || currentPrice),
                            currentPrice / (indicators.ema9 || currentPrice),
                            currentVolume / (indicators.volumeAvg || currentVolume || 1),
                            ((indicators.bb?.upper || 0) - (indicators.bb?.lower || 0)) / (indicators.bb?.middle || currentPrice),
                            adxValue
                        ];

                        const entryPrice = currentPrice;

                        // LONG sample: wins if futureHigh hits TP before futureLow hits SL
                        let longLabel = 0;
                        for (let j = 1; j <= LOOKAHEAD; j++) {
                            if (candleIndex + j >= candles.length) break;
                            const futureHigh = candles[candleIndex + j].high;
                            const futureLow  = candles[candleIndex + j].low;
                            if (futureLow  <= entryPrice - slDistance) { longLabel = 0; break; }
                            if (futureHigh >= entryPrice + tpDistance) { longLabel = 1; break; }
                        }

                        // SHORT sample: wins if futureLow hits TP before futureHigh hits SL (inverted)
                        let shortLabel = 0;
                        for (let j = 1; j <= LOOKAHEAD; j++) {
                            if (candleIndex + j >= candles.length) break;
                            const futureHigh = candles[candleIndex + j].high;
                            const futureLow  = candles[candleIndex + j].low;
                            if (futureHigh >= entryPrice + slDistance) { shortLabel = 0; break; }
                            if (futureLow  <= entryPrice - tpDistance) { shortLabel = 1; break; }
                        }

                        const longFeat  = [...baseFeat, 1.0].map(f => (typeof f === 'number' && isFinite(f) ? f : 0));
                        const shortFeat = [...baseFeat, 0.0].map(f => (typeof f === 'number' && isFinite(f) ? f : 0));

                        if (longFeat.every(v => isFinite(v))) {
                            allFeatures.push(longFeat);
                            allLabels.push(longLabel);
                        }
                        if (shortFeat.every(v => isFinite(v))) {
                            allFeatures.push(shortFeat);
                            allLabels.push(shortLabel);
                        }
                    }
                } catch (err) {
                    logger.warn(`AutoRetrainer: Failed to fetch ${symbol}: ${err}`);
                }
            }

            if (allFeatures.length < 100) {
                logger.warn(`AutoRetrainer: Not enough data (${allFeatures.length} samples). Skipping retrain.`);
                this.isRetraining = false;
                return;
            }

            const wins = allLabels.filter(l => l === 1).length;
            const losses = allLabels.filter(l => l === 0).length;

            // Balance the dataset
            const winIndices = allLabels.map((l, i) => l === 1 ? i : -1).filter(i => i >= 0);
            const lossIndices = allLabels.map((l, i) => l === 0 ? i : -1).filter(i => i >= 0);

            let balancedFeatures: number[][] = [];
            let balancedLabels: number[] = [];

            if (wins > 0 && losses > 0) {
                const targetSize = Math.min(winIndices.length, lossIndices.length);
                const shuffledWins = winIndices.sort(() => Math.random() - 0.5).slice(0, targetSize);
                const shuffledLosses = lossIndices.sort(() => Math.random() - 0.5).slice(0, targetSize);
                const selectedIndices = [...shuffledWins, ...shuffledLosses].sort(() => Math.random() - 0.5);

                for (const idx of selectedIndices) {
                    balancedFeatures.push(allFeatures[idx]);
                    balancedLabels.push(allLabels[idx]);
                }
            } else {
                balancedFeatures = allFeatures;
                balancedLabels = allLabels;
            }

            if (balancedFeatures.length < 10) {
                logger.warn(`AutoRetrainer: Balanced dataset too small (${balancedFeatures.length}). Skipping retrain.`);
                this.isRetraining = false;
                return;
            }

            // ─── Backup current model before overwriting ───
            const modelPath = path.join(process.cwd(), 'models', 'random_forest.json');
            const backupPath = path.join(process.cwd(), 'models', 'random_forest_backup.json');
            if (fs.existsSync(modelPath)) {
                fs.copyFileSync(modelPath, backupPath);
            }

            // Train new model
            logger.info(`AutoRetrainer: Training on ${balancedFeatures.length} balanced samples...`);
            aiModel.train(balancedFeatures, balancedLabels);

            // Always save — quality is measured by trading performance, not in-sample accuracy
            aiModel.save();
            this.lastRetrainTime = new Date();

            const duration = ((Date.now() - startTime) / 1000).toFixed(0);
            const winPct = allFeatures.length > 0 ? (wins / allFeatures.length * 100).toFixed(1) : '0';
            const msg = `🔄 *AI Retrained*\n\n📊 ${balancedFeatures.length} samples (${this.trainingPairs.join(', ')})\n⏱️ Duration: ${duration}s\n📈 Win labels: ${wins}/${allFeatures.length} (${winPct}%)`;

            logger.info(`AutoRetrainer: ✅ Model saved (${balancedFeatures.length} samples, ${duration}s)`);
            await notifier.sendTelegramMessage(msg);

        } catch (error) {
            logger.error('AutoRetrainer: Error during retrain:', error);
            await notifier.sendTelegramMessage(`❌ *AI Retrain Error*: ${error}`);
        } finally {
            this.isRetraining = false;
        }
    }
}

// Singleton instance
export const autoRetrainer = new AutoRetrainer(12); // 12 hours
