import { BybitExchange } from '../exchanges/BybitExchange';
import { IndicatorCalculator } from '../utils/indicators';
import { aiLearning, extractFeatures } from '../core/AdaptiveLearning';
import { config } from '../config/trading.config';
import { logger } from '../utils/logger';

async function runBacktest() {
    logger.info('🧪 Starting Backtest...');

    // Load AI Model
    await aiLearning.learn(); // Trigger load

    const exchange = new BybitExchange();
    const symbol = config.tradingPairs[0] || 'BTC/USDT';

    // Fetch Data with Retry
    logger.info(`Fetching historical data for ${symbol}...`);
    let candles: any[] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            candles = await exchange.fetchOHLCV(symbol, config.timeframe, 1000);
            if (candles.length > 0) break;
        } catch (error) {
            logger.warn(`Attempt ${attempt} failed to fetch data: ${error}`);
            if (attempt === 3) {
                logger.error('Failed to fetch data after 3 attempts.');
                return;
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (candles.length < 200) {
        logger.error('Not enough data.');
        return;
    }

    logger.info(`Got ${candles.length} candles for backtest.`);

    // ATR-based TP/SL (matches live + training)
    const ATR_SL_MULT = config.strategy.atrMultiplierSL || 2.0;
    const ATR_TP_MULT = config.strategy.atrMultiplierTP || 3.0;
    const LOOKAHEAD = 36;

    // Calculate Indicators
    const allIndicators = IndicatorCalculator.calculateAll(candles);
    const offset = candles.length - allIndicators.length;

    let goodSignals = 0;
    let totalSignals = 0;
    let strongSignals = 0;
    let strongGoodSignals = 0;

    const aiThreshold = aiLearning.getConfidenceThreshold('spot');
    logger.info(`AI Confidence Threshold: ${(aiThreshold * 100).toFixed(0)}%`);

    for (let i = 0; i < allIndicators.length - LOOKAHEAD; i++) {
        const indicators = allIndicators[i];
        const candleIndex = offset + i;
        const candle = candles[candleIndex];
        const currentPrice = candle.close;
        const atr = indicators.atr;

        // ATR-based SL/TP distances
        const slDistance = atr * ATR_SL_MULT;
        const tpDistance = atr * ATR_TP_MULT;

        // AI Score
        const features = extractFeatures(indicators, currentPrice, candle.volume);
        const aiScore = aiLearning.getPrediction(features);

        // Future Outcome (using ATR-based targets matching training)
        let isWin = false;

        for (let j = 1; j <= LOOKAHEAD; j++) {
            const next = candles[candleIndex + j];
            const highChange = next.high - currentPrice;
            const lowChange = next.low - currentPrice;

            // Check SL hit
            if (lowChange <= -slDistance) {
                isWin = false;
                break;
            }
            // Check TP hit
            if (highChange >= tpDistance) {
                isWin = true;
                break;
            }
        }

        // Count signals above 50%
        if (aiScore > 0.5) {
            totalSignals++;
            if (isWin) goodSignals++;
        }

        // Count signals above adaptive threshold
        if (aiScore >= aiThreshold) {
            strongSignals++;
            if (isWin) strongGoodSignals++;
        }
    }

    logger.info(`🔍 Backtest Analysis (Signal Quality):`);
    logger.info(`ATR-based: SL=${ATR_SL_MULT}x ATR, TP=${ATR_TP_MULT}x ATR, Lookahead=${LOOKAHEAD}`);
    logger.info(`---`);
    logger.info(`AI Signals (>50%): ${totalSignals}`);
    if (totalSignals > 0) {
        logger.info(`Profitable Signals: ${goodSignals}`);
        logger.info(`Precision (>50%): ${((goodSignals / totalSignals) * 100).toFixed(1)}%`);
    } else {
        logger.info(`Precision: N/A (No signals >50%)`);
    }
    logger.info(`---`);
    logger.info(`Strong Signals (>=${(aiThreshold * 100).toFixed(0)}%): ${strongSignals}`);
    if (strongSignals > 0) {
        logger.info(`Profitable Strong Signals: ${strongGoodSignals}`);
        logger.info(`Precision (strong): ${((strongGoodSignals / strongSignals) * 100).toFixed(1)}%`);
    } else {
        logger.info(`Precision (strong): N/A (No signals above threshold)`);
    }
}

runBacktest().catch(console.error);
