import {
    SMA,
    EMA,
    RSI,
    MACD,
    BollingerBands,
    ATR,
    ADX,
} from 'technicalindicators';

export interface OHLCV {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface TechnicalIndicators {
    ema9: number;
    ema21: number;
    rsi: number;
    macd: {
        MACD: number;
        signal: number;
        histogram: number;
    };
    bb: {
        upper: number;
        middle: number;
        lower: number;
    };
    atr: number;
    adx: number;
    volumeAvg: number;
    currentVolume: number;
    /** Rolling 50-candle VWAP (Volume-Weighted Average Price) */
    vwap?: number;
    /** Raw candle OHLC — used for candle body strength filter and AI features */
    high: number;
    low: number;
    close: number;
}

export class IndicatorCalculator {
    /**
     * Calculate all technical indicators for the given candles
     */
    static calculate(candles: OHLCV[]): TechnicalIndicators | null {
        const all = this.calculateAll(candles);
        if (all.length === 0) return null;
        return all[all.length - 1];
    }

    /**
     * Calculate all technical indicators for all candles
     */
    static calculateAll(candles: OHLCV[]): TechnicalIndicators[] {
        if (candles.length < 50) {
            return []; // Need at least 50 candles for reliable indicators
        }

        const closes = candles.map((c) => c.close);
        const highs = candles.map((c) => c.high);
        const lows = candles.map((c) => c.low);
        const volumes = candles.map((c) => c.volume);

        // EMA
        const ema9Values = EMA.calculate({ period: 9, values: closes });
        const ema21Values = EMA.calculate({ period: 21, values: closes });

        // RSI
        const rsiValues = RSI.calculate({ period: 14, values: closes });

        // MACD
        const macdValues = MACD.calculate({
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            values: closes,
            SimpleMAOscillator: false,
            SimpleMASignal: false,
        });

        // Bollinger Bands
        const bbValues = BollingerBands.calculate({
            period: 20,
            stdDev: 2,
            values: closes,
        });

        // ATR
        const atrValues = ATR.calculate({
            period: 14,
            high: highs,
            low: lows,
            close: closes,
        });

        // ADX (Average Directional Index) - Trend Strength
        const adxValues = ADX.calculate({
            period: 14,
            high: highs,
            low: lows,
            close: closes,
        });

        // Volume Average
        const volumeAvg = SMA.calculate({ period: 20, values: volumes });

        // ── Rolling VWAP (50-candle window) ──────────────────────────────────
        // typical_price = (high + low + close) / 3
        // vwap[i] = sum(tp * vol, i-49..i) / sum(vol, i-49..i)
        const VWAP_PERIOD = 50;
        const vwapValues: number[] = new Array(candles.length).fill(NaN);
        for (let i = VWAP_PERIOD - 1; i < candles.length; i++) {
            let cumTPV = 0, cumVol = 0;
            for (let j = i - VWAP_PERIOD + 1; j <= i; j++) {
                const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
                cumTPV += tp * candles[j].volume;
                cumVol += candles[j].volume;
            }
            vwapValues[i] = cumVol > 0 ? cumTPV / cumVol : candles[i].close;
        }

        // Align arrays (different indicators have different startup lags)
        const results: TechnicalIndicators[] = [];

        const len = candles.length;

        for (let i = 0; i < len; i++) {
            // Calculate local indices for each indicator
            const ema9Idx = i - (len - ema9Values.length);
            const ema21Idx = i - (len - ema21Values.length);
            const rsiIdx = i - (len - rsiValues.length);
            const macdIdx = i - (len - macdValues.length);
            const bbIdx = i - (len - bbValues.length);
            const atrIdx = i - (len - atrValues.length);
            const adxIdx = i - (len - adxValues.length);
            const volIdx = i - (len - volumeAvg.length);

            if (ema9Idx < 0 || ema21Idx < 0 || rsiIdx < 0 || macdIdx < 0 || bbIdx < 0 || atrIdx < 0 || adxIdx < 0 || volIdx < 0) {
                continue; // Not all indicators available yet
            }

            results.push({
                ema9: ema9Values[ema9Idx],
                ema21: ema21Values[ema21Idx],
                rsi: rsiValues[rsiIdx],
                macd: macdValues[macdIdx] as any,
                bb: bbValues[bbIdx] as any,
                atr: atrValues[atrIdx],
                adx: adxValues[adxIdx] as any,
                volumeAvg: volumeAvg[volIdx],
                currentVolume: volumes[i],
                vwap: isNaN(vwapValues[i]) ? undefined : vwapValues[i],
                high:  candles[i].high,
                low:   candles[i].low,
                close: candles[i].close,
            });
        }

        return results;
    }

    /**
     * Calculate EMA for a specific period
     */
    static calculateEMA(values: number[], period: number): number[] {
        return EMA.calculate({ period, values });
    }

    /**
     * Calculate RSI for a specific period
     */
    static calculateRSI(values: number[], period: number): number[] {
        return RSI.calculate({ period, values });
    }

    /**
     * Check if there's a bullish EMA crossover
     */
    static isBullishCrossover(
        ema9Current: number,
        ema21Current: number,
        ema9Previous: number,
        ema21Previous: number
    ): boolean {
        return ema9Previous <= ema21Previous && ema9Current > ema21Current;
    }

    /**
     * Check if there's a bearish EMA crossover
     */
    static isBearishCrossover(
        ema9Current: number,
        ema21Current: number,
        ema9Previous: number,
        ema21Previous: number
    ): boolean {
        return ema9Previous >= ema21Previous && ema9Current < ema21Current;
    }

    /**
     * Calculate percentage change
     */
    static percentageChange(oldValue: number, newValue: number): number {
        return ((newValue - oldValue) / oldValue) * 100;
    }

    /**
     * Normalize value to 0-1 range
     */
    static normalize(value: number, min: number, max: number): number {
        return (value - min) / (max - min);
    }

    /**
     * Calculate standard deviation
     */
    static standardDeviation(values: number[]): number {
        const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
        const squareDiffs = values.map((val) => Math.pow(val - avg, 2));
        const avgSquareDiff =
            squareDiffs.reduce((sum, val) => sum + val, 0) / values.length;
        return Math.sqrt(avgSquareDiff);
    }
}
