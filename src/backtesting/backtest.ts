import { BybitExchange } from '../exchanges/BybitExchange';
import { IndicatorCalculator } from '../utils/indicators';
import { aiLearning, extractFeatures } from '../core/AdaptiveLearning';
import { TrendFollowingStrategy } from '../strategies/TrendFollowingStrategy';
import { config } from '../config/trading.config';
import { logger } from '../utils/logger';

async function runBacktest() {
    logger.info('🧪 Starting Backtest (strategy-filtered pipeline)...');

    await aiLearning.learn();

    const exchange = new BybitExchange();
    const symbol = config.tradingPairs[0] || 'BTC/USDT';
    const strategy = new TrendFollowingStrategy();

    logger.info(`Fetching historical data for ${symbol}...`);
    let candles: any[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            candles = await exchange.fetchOHLCV(symbol, config.timeframe, 1000);
            if (candles.length > 0) break;
        } catch (error) {
            logger.warn(`Attempt ${attempt} failed: ${error}`);
            if (attempt === 3) { logger.error('Failed to fetch data.'); return; }
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (candles.length < 200) { logger.error('Not enough data.'); return; }
    logger.info(`Got ${candles.length} candles.`);

    const ATR_SL_MULT = config.strategy.atrMultiplierSL || 2.0;
    const ATR_TP_MULT = config.strategy.atrMultiplierTP || 4.0;
    const LOOKAHEAD   = 60;
    const AI_GATE     = 0.48;

    const aiThreshold = aiLearning.getConfidenceThreshold('futures');
    logger.info(`AI Confidence Threshold: ${(aiThreshold * 100).toFixed(0)}% | AI Gate (hard block): ${(AI_GATE * 100).toFixed(0)}%`);
    logger.info(`ATR: SL=${ATR_SL_MULT}x, TP=${ATR_TP_MULT}x, Lookahead=${LOOKAHEAD} candles`);

    let strategySignals = 0;
    let aiPassedSignals = 0;
    let aiPassedWins    = 0;
    let rawWins         = 0; // wins before AI gate

    // Need at least 30 candles for a valid indicator window + LOOKAHEAD room
    const START = 100;
    for (let i = START; i < candles.length - LOOKAHEAD; i++) {
        const window = candles.slice(0, i + 1);
        const indicators = IndicatorCalculator.calculate(window);
        if (!indicators) continue;

        const sig = strategy.analyze(window, indicators);
        if (sig.signal === 'hold') continue;

        strategySignals++;
        const isLong = sig.signal === 'buy';
        const entryPrice = candles[i].close;
        const atr = indicators.atr;
        if (!atr || atr <= 0) continue;

        const slDist = atr * ATR_SL_MULT;
        const tpDist = atr * ATR_TP_MULT;

        // Simulate outcome over lookahead window
        let isWin = false;
        for (let j = 1; j <= LOOKAHEAD; j++) {
            const next = candles[i + j];
            if (isLong) {
                if (next.low  <= entryPrice - slDist) { isWin = false; break; }
                if (next.high >= entryPrice + tpDist) { isWin = true;  break; }
            } else {
                if (next.high >= entryPrice + slDist) { isWin = false; break; }
                if (next.low  <= entryPrice - tpDist) { isWin = true;  break; }
            }
        }
        if (isWin) rawWins++;

        // Apply AI gate
        const features = extractFeatures(indicators, entryPrice, (indicators as any).currentVolume ?? 0, isLong);
        const aiScore  = aiLearning.getPrediction(features);
        if (aiScore < AI_GATE) continue;

        aiPassedSignals++;
        if (isWin) aiPassedWins++;
    }

    const rawPrecision = strategySignals > 0 ? (rawWins / strategySignals * 100).toFixed(1) : 'N/A';
    const aiPrecision  = aiPassedSignals > 0 ? (aiPassedWins / aiPassedSignals * 100).toFixed(1) : 'N/A';
    const aiFilterRate = strategySignals > 0 ? ((strategySignals - aiPassedSignals) / strategySignals * 100).toFixed(1) : '0';

    logger.info('');
    logger.info('📊 Backtest Results:');
    logger.info(`  Strategy signals (non-hold):  ${strategySignals}`);
    logger.info(`  → Raw win rate (no AI gate):  ${rawWins}/${strategySignals} = ${rawPrecision}%`);
    logger.info(`  AI filtered out:              ${strategySignals - aiPassedSignals} (${aiFilterRate}% of signals blocked)`);
    logger.info(`  AI-passed signals:            ${aiPassedSignals}`);
    logger.info(`  → AI-gated win rate:          ${aiPassedWins}/${aiPassedSignals} = ${aiPrecision}%`);
    logger.info(`  Break-even WR (${ATR_SL_MULT}:${ATR_TP_MULT} R:R): ${(100 / (1 + ATR_TP_MULT / ATR_SL_MULT)).toFixed(1)}%`);
}

runBacktest().catch(console.error);
