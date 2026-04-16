import { OHLCV, TechnicalIndicators } from '../utils/indicators';

export type SignalType = 'buy' | 'sell' | 'hold';

export interface TradeSignal {
    signal: SignalType;
    direction: 'long' | 'short'; // Explicit futures direction: 'long' = buy/hold, 'short' = sell/hold
    confidence: number; // 0-1
    price: number;
    indicators: TechnicalIndicators;
    reason: string;
}

export abstract class BaseStrategy {
    protected name: string;

    constructor(name: string) {
        this.name = name;
    }

    /**
     * Analyze market data and generate trading signal
     */
    abstract analyze(
        candles: OHLCV[],
        indicators: TechnicalIndicators
    ): TradeSignal;

    /**
     * Get strategy name
     */
    getName(): string {
        return this.name;
    }

    /**
     * Check if should enter a position (long or short)
     */
    shouldEnter(signal: TradeSignal): boolean {
        return signal.signal !== 'hold' && signal.confidence >= 0.3;
    }

    /**
     * Check if should exit a position
     */
    shouldExit(signal: TradeSignal): boolean {
        return signal.signal === 'sell';
    }
}
