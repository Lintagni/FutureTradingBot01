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

        // ─── SESSION FILTER ───────────────────────────────────────────────────
        // Skip new entry signals during Asian low-liquidity hours (00:00–06:00 UTC)
        // unless the trend is exceptionally strong (ADX > sessionDeadHoursAdxException).
        if ((config.strategy as any).sessionFilterEnabled) {
            const utcHour = new Date().getUTCHours();
            const { start, end } = (config.strategy as any).sessionDeadHoursUTC;
            const adxVal = typeof indicators.adx === 'object'
                ? (indicators.adx as any).adx || 0 : indicators.adx || 0;
            const adxException = (config.strategy as any).sessionDeadHoursAdxException || 35;
            if (utcHour >= start && utcHour < end && adxVal < adxException) {
                strategyLogger.info(`🌙 Session filter: ${utcHour}:00 UTC dead zone — skipping (ADX ${adxVal.toFixed(1)} < ${adxException})`);
                return this.holdSignal(currentPrice, indicators, `Dead session (${utcHour}:00 UTC)`);
            }
        }

        // Get previous indicators for crossover detection
        const prevCandles = candles.slice(0, -1);
        const prevIndicators = IndicatorCalculator.calculate(prevCandles);

        if (!prevIndicators) {
            return this.holdSignal(currentPrice, indicators, 'Insufficient data');
        }

        // ─── EMA200 MASTER TREND FILTER ───────────────────────────────────────
        // Only allow longs when price is above EMA200 (bull market structure).
        // Only allow shorts when price is below EMA200 (bear market structure).
        // When EMA200 is unavailable (< 200 candles), allow all signals (neutral).
        const ema200 = (indicators as any).ema200 as number | undefined;
        const aboveEma200 = ema200 === undefined || currentPrice > ema200;
        const belowEma200 = ema200 === undefined || currentPrice < ema200;

        // ─── MARKET STRUCTURE CHECK ───────────────────────────────────────────
        // Confirm HH/HL for longs, LH/LL for shorts using the last two swing points.
        const swingLow1  = IndicatorCalculator.findSwingLow(candles, 5, 40);
        const swingLow2  = IndicatorCalculator.findSwingLow(candles.slice(0, -10), 5, 40);
        const swingHigh1 = IndicatorCalculator.findSwingHigh(candles, 5, 40);
        const swingHigh2 = IndicatorCalculator.findSwingHigh(candles.slice(0, -10), 5, 40);
        const higherLows  = swingLow1  !== null && swingLow2  !== null && swingLow1  > swingLow2;
        const lowerHighs  = swingHigh1 !== null && swingHigh2 !== null && swingHigh1 < swingHigh2;

        let confidence = 0;
        let signal: 'buy' | 'sell' | 'hold' = 'hold';
        let reason = '';

        // ─── STOCHASTIC RSI ───
        const stoch = indicators.stochRSI;
        const prevStoch = prevIndicators.stochRSI;
        // Crossover: %K just crossed above/below %D
        const stochBullishCross = stoch && prevStoch && prevStoch.k < prevStoch.d && stoch.k > stoch.d;
        const stochBearishCross = stoch && prevStoch && prevStoch.k > prevStoch.d && stoch.k < stoch.d;
        const stochOverbought = stoch && stoch.k > 80;
        const stochOversold  = stoch && stoch.k < 20;

        // ─── ADX TREND FILTER ───
        // ADX < 20 = ranging/choppy market → EMA crossovers will whipsaw
        const adxValue = typeof indicators.adx === 'object'
            ? (indicators.adx as any).adx || 0
            : indicators.adx || 0;
        const isTrending = adxValue > 25; // ADX 25+ = confirmed trend

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
            // EMA200 master trend gate
            if (!aboveEma200) {
                strategyLogger.info(`⚠️ LONG rejected: price $${currentPrice.toFixed(4)} below EMA200 $${ema200!.toFixed(4)} — bear market`);
                return this.holdSignal(currentPrice, indicators, 'LONG blocked: below EMA200');
            }

            signal = 'buy';
            confidence += 0.3;
            reason = 'Bullish EMA crossover';
            // Market structure bonus
            if (higherLows) { confidence += 0.05; reason += ', HH/HL confirmed'; }

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

            // Stochastic RSI momentum confirmation
            if (stochBullishCross && !stochOverbought) {
                confidence += 0.10;
                reason += `, StochRSI↑ (K:${stoch!.k.toFixed(0)})`;
            } else if (stochOverbought) {
                confidence -= 0.10;
                reason += `, StochRSI overbought (${stoch!.k.toFixed(0)})`;
            }

        }
        // Bearish conditions
        else if (bearishCrossover) {
            if (!isTrending) {
                strategyLogger.info(`⚠️ Bearish crossover rejected: ADX ${adxValue.toFixed(1)} < 25 (ranging market)`);
                return this.holdSignal(currentPrice, indicators, `Crossover rejected: ADX too low (${adxValue.toFixed(1)})`);
            }
            // EMA200 master trend gate
            if (!belowEma200) {
                strategyLogger.info(`⚠️ SHORT rejected: price $${currentPrice.toFixed(4)} above EMA200 $${ema200!.toFixed(4)} — bull market`);
                return this.holdSignal(currentPrice, indicators, 'SHORT blocked: above EMA200');
            }

            signal = 'sell';
            confidence += 0.3;
            reason = 'Bearish EMA crossover';
            // Market structure bonus
            if (lowerHighs) { confidence += 0.05; reason += ', LH/LL confirmed'; }

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

            // Stochastic RSI momentum confirmation
            if (stochBearishCross && !stochOversold) {
                confidence += 0.10;
                reason += `, StochRSI↓ (K:${stoch!.k.toFixed(0)})`;
            } else if (stochOversold) {
                confidence -= 0.10;
                reason += `, StochRSI oversold (${stoch!.k.toFixed(0)})`;
            }

        }
        // Continuation & Extreme conditions
        else {
            const ema50 = (indicators as any).ema50 as number | undefined;

            // Strong uptrend continuation — allow entry up to 5% above EMA50
            if (
                adxValue > 25 &&
                indicators.ema9 > indicators.ema21 &&
                currentPrice > indicators.ema9 &&
                indicators.rsi > 52 &&
                indicators.rsi < config.strategy.rsiOverbought &&
                indicators.macd.histogram > 0 &&
                currentVolume > indicators.volumeAvg * 1.2 &&
                (!ema50 || currentPrice < ema50 * 1.05) &&
                aboveEma200
            ) {
                signal = 'buy';
                confidence = 0.68;
                reason = 'Uptrend continuation (ADX+MACD confirmed)';
                if (higherLows) { confidence += 0.05; reason += ', HH/HL structure'; }
                if (ema50 && currentPrice >= ema50 && currentPrice < ema50 * 1.005) {
                    confidence += 0.07;
                    reason += ', fresh EMA50 breakout';
                } else if (ema50 && currentPrice >= ema50 * 1.03) {
                    confidence -= 0.05;
                    reason += ', extended above EMA50';
                }
            }
            // EMA20 pullback in uptrend — price dips to EMA20 (fast EMA) support zone
            else if (
                adxValue > 20 &&
                indicators.ema9 > indicators.ema21 &&
                currentPrice <= indicators.ema9 * 1.005 &&
                currentPrice >= indicators.ema9 * 0.99 &&
                indicators.rsi > 40 && indicators.rsi < 60 &&
                indicators.macd.MACD > indicators.macd.signal
            ) {
                signal = 'buy';
                confidence = 0.62;
                reason = 'Pullback to EMA20 in uptrend';
            }
            // Strong downtrend continuation — allow up to 5% below EMA50
            else if (
                isTrending &&
                indicators.ema9 < indicators.ema21 &&
                currentPrice < indicators.ema9 &&
                indicators.rsi < 50 &&
                indicators.macd.MACD < indicators.macd.signal &&
                indicators.macd.histogram < 0 &&
                (!ema50 || currentPrice > ema50 * 0.95) &&
                belowEma200
            ) {
                signal = 'sell';
                confidence = 0.75;
                reason = 'Downtrend continuation';
                if (lowerHighs) { confidence += 0.05; reason += ', LH/LL structure'; }
                if (ema50 && currentPrice <= ema50 && currentPrice > ema50 * 0.995) {
                    confidence += 0.05;
                    reason += ', fresh EMA50 break';
                }
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
