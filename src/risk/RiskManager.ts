import { config } from '../config/trading.config';
import { riskLogger } from '../utils/logger';
import { tradeRepository } from '../database/TradeRepository';

// Direction of trade for risk calculations
export type TradeSide = 'buy' | 'sell';

export interface PositionSize {
    amount: number; // Amount in base currency (e.g., BTC)
    cost: number; // Cost in quote currency (e.g., USDT)
    stopLoss: number; // Stop loss price
    takeProfit: number; // Take profit price
}

export class RiskManager {
    /**
     * Return the capital tier for a given USDT balance.
     * Everything that depends on account size reads from this.
     */
    static getTier(balance: number) {
        const tiers = config.capitalTiers;
        return tiers.find(t => balance <= t.maxBalance) ?? tiers[tiers.length - 1];
    }

    /**
     * Calculate position size based on available capital and risk parameters
     */
    async calculatePositionSize(
        symbol: string,
        currentPrice: number,
        availableCapital: number,
        exchange: any
    ): Promise<PositionSize> {
        const tier = RiskManager.getTier(availableCapital);

        // Tier-based position % and leverage
        let targetCost = availableCapital * tier.positionPct;
        const leverage = tier.leverage;
        const notionalValue = targetCost * leverage;

        // Dynamic min size: 5% of balance (floors at $1 for micro accounts)
        let minSize = Math.max(1, availableCapital * 0.05);
        const maxSize = config.risk.maxPositionSize;

        riskLogger.info(`📊 Tier: ${tier.name} | Balance: $${availableCapital.toFixed(2)} | Position: ${(tier.positionPct * 100).toFixed(0)}% | Leverage: ${leverage}x | MinSize: $${minSize.toFixed(2)}`);

        // Overlay with exchange-specific minimum if available
        if (exchange && exchange.getMinOrderValue) {
            const exchangeMin = await exchange.getMinOrderValue(symbol);
            minSize = Math.max(minSize, exchangeMin);
        }

        // Clamp between min and max
        targetCost = Math.max(targetCost, minSize);
        targetCost = Math.min(targetCost, maxSize);

        // Calculate stop loss and take profit prices (defaults — overridden by ATR-based calc in engine)
        const slPct = config.risk.stopLossPercentage;
        const tpPct = config.risk.takeProfitPercentage;

        const stopLoss = currentPrice * (1 - slPct / 100);
        const takeProfit = currentPrice * (1 + tpPct / 100);

        // For futures: amount of contracts = notional value / price (leverage applied)
        // For spot: amount = targetCost / price (no leverage)
        let amount = notionalValue / currentPrice;

        // Overlay with exchange-specific minimum AMOUNT if available
        if (exchange && exchange.getMinOrderAmount) {
            const minAmount = await exchange.getMinOrderAmount(symbol);
            if (amount < minAmount) {
                riskLogger.info(`Adjusting amount for ${symbol} from ${amount.toFixed(6)} to min ${minAmount}`);
                amount = minAmount;
                targetCost = amount * currentPrice;
            }
        }

        riskLogger.info(
            `Position size for ${symbol}: ${amount.toFixed(6)} contracts @ $${currentPrice.toFixed(2)} (Margin: $${targetCost.toFixed(2)}, Notional: $${notionalValue.toFixed(2)}, ${leverage}x leverage)`
        );
        riskLogger.info(
            `Stop Loss: $${stopLoss.toFixed(2)} | Take Profit: $${takeProfit.toFixed(2)}`
        );

        return {
            amount,
            cost: targetCost,
            stopLoss,
            takeProfit,
        };
    }

    /**
     * Check if we can open a new position based on risk limits
     */
    async canOpenPosition(symbol: string): Promise<boolean> {
        // Check number of open positions
        const openTrades = await tradeRepository.getOpenTrades();

        if (openTrades.length >= config.risk.maxOpenPositions) {
            riskLogger.warn(
                `Cannot open position: Max open positions reached`
            );
            return false;
        }

        // Check daily loss limit
        const today = new Date();
        const dailyPnl = await tradeRepository.getDailyPnL(today);
        const maxLoss = config.risk.maxDailyLoss;

        if (dailyPnl < -maxLoss) {
            riskLogger.warn(
                `Cannot open position: Daily loss limit reached ($${dailyPnl.toFixed(2)})`
            );
            return false;
        }

        // Check if we already have an open position for this symbol
        const existingPosition = openTrades.find((trade) => trade.symbol === symbol);
        if (existingPosition) {
            riskLogger.warn(`Already have open position for ${symbol}`);
            return false;
        }

        return true;
    }

    /**
     * Check if stop loss or take profit has been hit.
     * For SHORT positions, SL is above entry and TP is below.
     */
    shouldClosePosition(
        currentPrice: number,
        stopLoss: number,
        takeProfit: number,
        side: 'buy' | 'sell' = 'buy'
    ): { shouldClose: boolean; reason: string } {
        const isShort = side === 'sell';

        if (isShort) {
            // Short: price rising hits SL, price falling hits TP
            if (currentPrice >= stopLoss) return { shouldClose: true, reason: 'Stop loss hit' };
            if (currentPrice <= takeProfit) return { shouldClose: true, reason: 'Take profit hit' };
        } else {
            // Long: price falling hits SL, price rising hits TP
            if (currentPrice <= stopLoss) return { shouldClose: true, reason: 'Stop loss hit' };
            if (currentPrice >= takeProfit) return { shouldClose: true, reason: 'Take profit hit' };
        }

        return { shouldClose: false, reason: '' };
    }

    /**
     * Calculate P&L for a trade, accounting for leverage and position side.
     */
    calculatePnL(
        entryPrice: number,
        exitPrice: number,
        amount: number,
        fee: number = 0,
        side: 'buy' | 'sell' = 'buy',
        leverage: number = 1
    ): { pnl: number; pnlPercentage: number } {
        const isShort = side === 'sell';
        // Short profits when price drops; long profits when price rises
        const priceDiff = isShort ? entryPrice - exitPrice : exitPrice - entryPrice;
        const pnl = priceDiff * amount * leverage - fee;
        // pnlPercentage is relative to the margin used (cost = amount * entryPrice / leverage)
        const marginUsed = (entryPrice * amount) / leverage;
        const pnlPercentage = marginUsed > 0 ? (pnl / marginUsed) * 100 : 0;

        return { pnl, pnlPercentage };
    }

    /**
     * Update trailing stop loss (for future enhancement)
     */
    updateTrailingStop(
        currentPrice: number,
        currentStopLoss: number,
        trailingPercentage: number = 2
    ): number {
        const newStopLoss = currentPrice * (1 - trailingPercentage / 100);

        // Only update if new stop loss is higher than current
        if (newStopLoss > currentStopLoss) {
            riskLogger.info(
                `Trailing stop updated: $${currentStopLoss.toFixed(2)} -> $${newStopLoss.toFixed(2)}`
            );
            return newStopLoss;
        }

        return currentStopLoss;
    }

    /**
     * Get risk metrics summary
     */
    async getRiskMetrics(): Promise<{
        openPositions: number;
        dailyPnl: number;
        totalPnl: number;
        riskUtilization: number;
    }> {
        const openTrades = await tradeRepository.getOpenTrades();
        const today = new Date();
        const dailyPnl = await tradeRepository.getDailyPnL(today);
        const totalPnl = await tradeRepository.getTotalPnL();

        const riskUtilization =
            (openTrades.length / config.risk.maxOpenPositions) * 100;

        return {
            openPositions: openTrades.length,
            dailyPnl,
            totalPnl,
            riskUtilization,
        };
    }
}

export const riskManager = new RiskManager();
