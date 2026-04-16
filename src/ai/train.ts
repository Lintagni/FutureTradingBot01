import { BybitExchange } from '../exchanges/BybitExchange';
import { IndicatorCalculator } from '../utils/indicators';
import { aiModel } from './RandomForestModel';
import { logger } from '../utils/logger';
import { config } from '../config/trading.config';

async function trainModel() {
    logger.info('🧠 Starting AI Training...');

    const exchange = new BybitExchange();

    // Train on MULTIPLE pairs for better generalization
    const trainingPairs = ['SOL/USDT', 'BTC/USDT', 'ETH/USDT'];

    const allFeatures: number[][] = [];
    const allLabels: number[] = [];

    // ATR-based TP/SL matching live trading
    const ATR_SL_MULT = config.strategy.atrMultiplierSL || 2.0;
    const ATR_TP_MULT = config.strategy.atrMultiplierTP || 3.0;
    const LOOKAHEAD = 36;

    logger.info(`Training parameters: ATR SL Mult=${ATR_SL_MULT}x, ATR TP Mult=${ATR_TP_MULT}x, Lookahead=${LOOKAHEAD} candles`);

    for (const symbol of trainingPairs) {
        logger.info(`Fetching historical data for ${symbol}...`);
        try {
            const candles = await exchange.fetchOHLCV(symbol, config.timeframe, 1000);

            if (candles.length < 200) {
                logger.warn(`Not enough data for ${symbol}, skipping.`);
                continue;
            }

            logger.info(`Got ${candles.length} candles for ${symbol}.`);

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

                // ATR-based SL/TP distances
                const slDistance = atr * ATR_SL_MULT;
                const tpDistance = atr * ATR_TP_MULT;

                // Extract ADX properly (can be object or number)
                const adxValue = typeof indicators.adx === 'object'
                    ? (indicators.adx as any).adx || 0
                    : indicators.adx || 0;

                const feat = [
                    indicators.rsi || 50,
                    indicators.macd?.histogram || 0,
                    currentPrice / (indicators.ema21 || currentPrice),
                    currentPrice / (indicators.ema9 || currentPrice),
                    currentVolume / (indicators.volumeAvg || currentVolume || 1),
                    ((indicators.bb?.upper || 0) - (indicators.bb?.lower || 0)) / (indicators.bb?.middle || currentPrice),
                    adxValue
                ];

                // Determine Label using ATR-based SL/TP
                let label = 0;
                const entryPrice = currentPrice;

                for (let j = 1; j <= LOOKAHEAD; j++) {
                    if (candleIndex + j >= candles.length) break;

                    const futureHigh = candles[candleIndex + j].high;
                    const futureLow = candles[candleIndex + j].low;

                    if (futureLow <= entryPrice - slDistance) {
                        label = 0;
                        break;
                    }
                    if (futureHigh >= entryPrice + tpDistance) {
                        label = 1;
                        break;
                    }
                }

                // Sanitize features
                const validFeatures = feat.map(f => {
                    const val = typeof f === 'number' && isFinite(f) ? f : 0;
                    return val;
                });

                if (validFeatures.every(v => typeof v === 'number' && isFinite(v))) {
                    allFeatures.push(validFeatures);
                    allLabels.push(label);
                }
            }
        } catch (err) {
            logger.warn(`Failed to fetch data for ${symbol}: ${err}`);
        }
    }

    logger.info(`Total samples: ${allFeatures.length}`);
    const wins = allLabels.filter(l => l === 1).length;
    const losses = allLabels.filter(l => l === 0).length;
    logger.info(`Win: ${wins} (${(wins / allLabels.length * 100).toFixed(1)}%) | Loss: ${losses} (${(losses / allLabels.length * 100).toFixed(1)}%)`);

    // ─── BALANCE THE DATASET ───
    // Random Forest performs much better with balanced classes
    // Use undersampling of majority class
    const winIndices = allLabels.map((l, i) => l === 1 ? i : -1).filter(i => i >= 0);
    const lossIndices = allLabels.map((l, i) => l === 0 ? i : -1).filter(i => i >= 0);

    let balancedFeatures: number[][] = [];
    let balancedLabels: number[] = [];

    if (wins > 0 && losses > 0) {
        const targetSize = Math.min(winIndices.length, lossIndices.length);

        // Shuffle and take equal amounts
        const shuffledWins = winIndices.sort(() => Math.random() - 0.5).slice(0, targetSize);
        const shuffledLosses = lossIndices.sort(() => Math.random() - 0.5).slice(0, targetSize);

        const selectedIndices = [...shuffledWins, ...shuffledLosses].sort(() => Math.random() - 0.5);

        for (const idx of selectedIndices) {
            balancedFeatures.push(allFeatures[idx]);
            balancedLabels.push(allLabels[idx]);
        }

        logger.info(`Balanced dataset: ${balancedFeatures.length} samples (${targetSize} wins + ${targetSize} losses)`);
    } else {
        logger.warn('⚠️ Cannot balance: one class has zero samples. Using unbalanced.');
        balancedFeatures = allFeatures;
        balancedLabels = allLabels;
    }

    // Train Model
    logger.info('Training Random Forest...');
    aiModel.train(balancedFeatures, balancedLabels);

    // Quick self-test
    let correct = 0;
    for (let i = 0; i < Math.min(50, balancedFeatures.length); i++) {
        const prob = aiModel.predictProbability(balancedFeatures[i]);
        const predicted = prob >= 0.5 ? 1 : 0;
        if (predicted === balancedLabels[i]) correct++;
    }
    logger.info(`Self-test accuracy: ${((correct / Math.min(50, balancedFeatures.length)) * 100).toFixed(0)}% (on ${Math.min(50, balancedFeatures.length)} samples)`);

    // Save Model
    aiModel.save();

    logger.info('✅ Training complete.');
}

trainModel().catch(console.error);
