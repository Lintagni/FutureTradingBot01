import { BaseStrategy, TradeSignal } from './BaseStrategy';
import { OHLCV, TechnicalIndicators, IndicatorCalculator } from '../utils/indicators';
import { config } from '../config/trading.config';
import { strategyLogger } from '../utils/logger';

export class TrendFollowingStrategy extends BaseStrategy {
    constructor() {
        super('TrendFollowing');
    }

    analyze(candles: OHLCV[], indicators: TechnicalIndicators): TradeSignal {
        const currentPrice = candles[candles.length - 1].close;
        const currentVolume = candles[candles.length - 1].volume;

        // Get previous indicators for crossover detection
        const prevCandles = candles.slice(0, -1);
        const prevIndicators = IndicatorCalculator.calculate(prevCandles);

        if (!prevIndicators) {
            return this.holdSignal(currentPrice, indicators, 'Insufficient data');
        }

        let confidence = 0;
        let signal: 'buy' | 'sell' | 'hold' = 'hold';
        let reason = '';

        // ─── ADX TREND FILTER ───
        // ADX < 20 = ranging/choppy market → EMA crossovers will whipsaw
        const adxValue = typeof indicators.adx === 'object'
            ? (indicators.adx as any).adx || 0
            : indicators.adx || 0;
        const isTrending = adxValue > 25; // ADX 25+ = confirmed trend (18 was too loose, allowed ranging entries)

        // Check for bullish signals
        const bullishCrossover = IndicatorCalculator.isBullishCrossover(
            indicators.ema9,
            indicators.ema21,
            prevIndicators.ema9,
            prevIndicators.ema21
        );

        const bearishCrossover = IndicatorCalculator.isBearishCrossover(
            indicators.ema9,
            indicators.ema21,
            prevIndicators.ema9,
            prevIndicators.ema21
        );

        // Bullish conditions
        if (bullishCrossover) {
            // Gate: Only act on crossovers in trending markets
            if (!isTrending) {
                strategyLogger.info(`⚠️ Bullish crossover rejected: ADX ${adxValue.toFixed(1)} < 25 (ranging market)`);
                return this.holdSignal(currentPrice, indicators, `Crossover rejected: ADX too low (${adxValue.toFixed(1)})`);
            }

            signal = 'buy';
            confidence += 0.3;
            reason = 'Bullish EMA crossover';

            // ADX bonus: stronger trend = higher confidence
            if (adxValue > 30) {
                confidence += 0.05;
                reason += `, strong trend (ADX ${adxValue.toFixed(0)})`;
            }

            // Confirm with MACD
            if (indicators.macd.MACD > indicators.macd.signal && indicators.macd.histogram > 0) {
                confidence += 0.2;
                reason += ', MACD bullish';
            }

            // Confirm with RSI (must be above 50 — bullish momentum territory — and not overbought)
            if (indicators.rsi > 50 && indicators.rsi < config.strategy.rsiOverbought) {
                confidence += 0.15;
                reason += ', RSI favorable';
            } else if (indicators.rsi <= 50) {
                // RSI below 50 — momentum not yet bullish
                confidence -= 0.05;
                reason += ', RSI weak';
            }

            // Confirm with volume
            if (currentVolume > indicators.volumeAvg * config.strategy.volumeMultiplier) {
                confidence += 0.15;
                reason += ', high volume';
            }

            // Price above EMA21 (uptrend)
            if (currentPrice > indicators.ema21) {
                confidence += 0.1;
                reason += ', price above EMA21';
            }

            // Not at upper Bollinger Band
            if (currentPrice < indicators.bb.upper) {
                confidence += 0.05;
                reason += ', room to grow';
            }

            // VWAP confirmation: price above VWAP = bullish bias
            if (indicators.vwap && currentPrice > indicators.vwap) {
                confidence += 0.05;
                reason += ', above VWAP';
            }

        }
        // Bearish conditions
        else if (bearishCrossover) {
            if (!isTrending) {
                strategyLogger.info(`⚠️ Bearish crossover rejected: ADX ${adxValue.toFixed(1)} < 25 (ranging market)`);
                return this.holdSignal(currentPrice, indicators, `Crossover rejected: ADX too low (${adxValue.toFixed(1)})`);
            }

            signal = 'sell';
            confidence += 0.3;
            reason = 'Bearish EMA crossover';

            if (adxValue > 30) {
                confidence += 0.05;
                reason += `, strong trend (ADX ${adxValue.toFixed(0)})`;
            }

            // Confirm with MACD
            if (indicators.macd.MACD < indicators.macd.signal && indicators.macd.histogram < 0) {
                confidence += 0.2;
                reason += ', MACD bearish';
            }

            // Confirm with RSI (must be below 50 — bearish momentum territory — and not oversold)
            if (indicators.rsi < 50 && indicators.rsi > config.strategy.rsiOversold) {
                confidence += 0.15;
                reason += ', RSI bearish';
            }

            // Confirm with volume
            if (currentVolume > indicators.volumeAvg * config.strategy.volumeMultiplier) {
                confidence += 0.15;
                reason += ', high volume';
            }

            // Price below EMA21 (downtrend)
            if (currentPrice < indicators.ema21) {
                confidence += 0.1;
                reason += ', price below EMA21';
            }

            // At or above upper Bollinger Band (overbought)
            if (currentPrice >= indicators.bb.upper) {
                confidence += 0.05;
                reason += ', overbought';
            }

            // VWAP confirmation: price below VWAP = bearish bias
            if (indicators.vwap && currentPrice < indicators.vwap) {
                confidence += 0.05;
                reason += ', below VWAP';
            }
        }
        // Continuation & Extreme conditions
        else {
            // Strong uptrend continuation
            if (
                adxValue > 25 &&
                indicators.ema9 > indicators.ema21 &&
                currentPrice > indicators.ema9 &&
                indicators.rsi > 50 &&
                indicators.rsi < config.strategy.rsiOverbought &&
                indicators.macd.histogram > 0 &&
                currentVolume > indicators.volumeAvg * 1.1
            ) {
                signal = 'buy';
                confidence = 0.68;
                reason = 'Uptrend continuation (ADX+MACD confirmed)';
            }
            // Strong downtrend continuation (exit signal)
            else if (
                isTrending &&
                indicators.ema9 < indicators.ema21 &&
                currentPrice < indicators.ema9 &&
                indicators.rsi < 50 &&
                indicators.macd.MACD < indicators.macd.signal &&
                indicators.macd.histogram < 0
            ) {
                signal = 'sell';
                confidence = 0.75;
                reason = 'Downtrend continuation';
            }
            // Oversold bounce
            else if (
                indicators.rsi < 25 &&
                currentPrice <= indicators.bb.lower &&
                indicators.macd.histogram > prevIndicators.macd.histogram &&
                adxValue > 20
            ) {
                signal = 'buy';
                confidence = 0.55;
                reason = 'Extreme oversold bounce';
            }
            // Overbought reversal
            else if (
                indicators.rsi > 75 &&
                currentPrice >= indicators.bb.upper &&
                indicators.macd.histogram < prevIndicators.macd.histogram &&
                adxValue > 20
            ) {
                signal = 'sell';
                confidence = 0.55;
                reason = 'Extreme overbought reversal';
            }
        }

        // ─── CANDLE BODY STRENGTH FILTER ───
        // Reject entries on doji / indecision candles (close near midpoint of range).
        // LONG needs close in upper 50%+ of range; SHORT needs close in lower 50%.
        if (signal !== 'hold') {
            const lastCandle = candles[candles.length - 1];
            const candleRange = lastCandle.high - lastCandle.low;
            const bodyStrength = candleRange > 0
                ? (lastCandle.close - lastCandle.low) / candleRange
                : 0.5;

            if (signal === 'buy' && bodyStrength < 0.50) {
                strategyLogger.info(`⚠️ LONG rejected: weak candle close (body ${(bodyStrength * 100).toFixed(0)}% of range)`);
                return this.holdSignal(currentPrice, indicators, `Indecision candle: body ${(bodyStrength * 100).toFixed(0)}% — not bullish`);
            }
            if (signal === 'sell' && bodyStrength > 0.50) {
                strategyLogger.info(`⚠️ SHORT rejected: weak candle close (body ${(bodyStrength * 100).toFixed(0)}% of range)`);
                return this.holdSignal(currentPrice, indicators, `Indecision candle: body ${(bodyStrength * 100).toFixed(0)}% — not bearish`);
            }
        }

        // Ensure reason is not empty for hold signals
        if (signal === 'hold' && !reason) {
            reason = 'No strong signal';
        }

        // Cap confidence at 1.0
        confidence = Math.min(confidence, 1.0);

        strategyLogger.info(
            `${this.name} analysis: ${signal} (${(confidence * 100).toFixed(1)}%) - ${reason} [ADX: ${adxValue.toFixed(1)}]`
        );

        // Determine direction: 'long' for buy signals, 'short' for sell signals
        const direction: 'long' | 'short' = signal === 'sell' ? 'short' : 'long';

        return {
            signal,
            direction,
            confidence,
            price: currentPrice,
            indicators,
            reason,
        };
    }

    private holdSignal(
        price: number,
        indicators: TechnicalIndicators,
        reason: string
    ): TradeSignal {
        return {
            signal: 'hold',
            direction: 'long', // neutral default — no position change implied
            confidence: 0,
            price,
            indicators,
            reason,
        };
    }
}
