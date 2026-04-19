import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

export const prisma = new PrismaClient({
    log: ['error', 'warn'],
});

export interface CreateTradeData {
    exchange: string;
    symbol: string;
    side: string;
    type: string;
    amount: number;
    price: number;
    cost: number;
    fee: number;
    entryPrice: number;
    strategy: string;
    signal: string;
    confidence?: number;
    marketType?: string;
    leverage?: number;
    entryFeatures?: string; // JSON-encoded AI feature array at entry time
}

export interface UpdateTradeData {
    exitPrice: number;
    exitTime: Date;
    realizedPnl: number;
    pnlPercentage: number;
    status: string;
}

export class TradeRepository {
    /**
     * Create a new trade record
     */
    async createTrade(data: CreateTradeData) {
        try {
            return await prisma.trade.create({
                data: {
                    ...data,
                    entryTime: new Date(),
                    status: 'open',
                    marketType: data.marketType || 'spot',
                },
            });
        } catch (error) {
            logger.error('Error creating trade:', error);
            throw error;
        }
    }

    /**
     * Update trade when position is closed
     */
    async updateTrade(tradeId: string, data: UpdateTradeData) {
        try {
            return await prisma.trade.update({
                where: { id: tradeId },
                data,
            });
        } catch (error) {
            logger.error('Error updating trade:', error);
            throw error;
        }
    }

    /**
     * Get all open trades
     */
    async getOpenTrades(symbol?: string, marketType: string = 'spot') {
        try {
            return await prisma.trade.findMany({
                where: {
                    status: 'open',
                    marketType,
                    ...(symbol && { symbol }),
                },
                orderBy: { entryTime: 'desc' },
            });
        } catch (error) {
            logger.error('Error fetching open trades:', error);
            throw error;
        }
    }

    /**
     * Get trade by ID
     */
    async getTradeById(tradeId: string) {
        try {
            return await prisma.trade.findUnique({
                where: { id: tradeId },
            });
        } catch (error) {
            logger.error('Error fetching trade:', error);
            throw error;
        }
    }

    /**
     * Get recent trades
     */
    async getRecentTrades(limit: number = 10, marketType: string = 'spot') {
        try {
            return await prisma.trade.findMany({
                where: { marketType },
                orderBy: { createdAt: 'desc' },
                take: limit,
            });
        } catch (error) {
            logger.error('Error fetching recent trades:', error);
            throw error;
        }
    }

    /**
     * Get trades for a specific date range
     */
    async getTradesByDateRange(startDate: Date, endDate: Date) {
        try {
            return await prisma.trade.findMany({
                where: {
                    entryTime: {
                        gte: startDate,
                        lte: endDate,
                    },
                },
                orderBy: { entryTime: 'desc' },
            });
        } catch (error) {
            logger.error('Error fetching trades by date range:', error);
            throw error;
        }
    }

    /**
     * Calculate total P&L
     */
    async getTotalPnL(marketType: string = 'spot') {
        try {
            const result = await prisma.trade.aggregate({
                where: { status: 'closed', marketType },
                _sum: { realizedPnl: true },
            });
            const raw = result._sum.realizedPnl;
            return (raw != null && Number.isFinite(raw)) ? raw : 0;
        } catch (error) {
            logger.error('Error calculating total P&L:', error);
            throw error;
        }
    }

    /**
     * Get count of closed trades
     */
    async getClosedTradeCount(marketType: string = 'futures'): Promise<number> {
        try {
            return await prisma.trade.count({
                where: { status: 'closed', marketType },
            });
        } catch (error) {
            logger.error('Error counting closed trades:', error);
            return 0;
        }
    }

    /**
     * Get Lifetime Win Rate
     */
    async getLifetimeWinRate(marketType: string = 'spot') {
        try {
            // Count all closed trades (including those with NULL realizedPnl — treated as losses)
            const totalClosed = await prisma.trade.count({
                where: { status: 'closed', marketType }
            });

            if (totalClosed === 0) return 0;

            const wins = await prisma.trade.count({
                where: {
                    status: 'closed',
                    marketType,
                    realizedPnl: { gt: 0 }
                }
            });

            return (wins / totalClosed) * 100;
        } catch (error) {
            logger.error('Error calculating lifetime win rate:', error);
            return 0;
        }
    }

    /**
     * Repair closed trades whose realizedPnl was stored as NULL (e.g. due to a NaN bug).
     * Recalculates P&L from stored entryPrice, exitPrice, side, amount, leverage, fee.
     */
    async repairNullPnl(marketType: string = 'futures'): Promise<number> {
        try {
            const broken = await prisma.trade.findMany({
                where: {
                    status: 'closed',
                    marketType,
                    exitPrice: { not: null },
                    realizedPnl: null,
                },
            });

            if (broken.length === 0) return 0;

            logger.info(`🔧 Repairing ${broken.length} closed trades with NULL realizedPnl...`);

            let fixed = 0;
            for (const t of broken) {
                try {
                    const entryPrice = t.entryPrice ?? t.price ?? 0;
                    const exitPrice  = t.exitPrice as number;
                    const amount     = t.amount ?? 0;
                    const leverage   = (t as any).leverage ?? 1;
                    const fee        = t.fee ?? 0;
                    const isShort    = t.side === 'sell';

                    const priceDiff  = isShort ? entryPrice - exitPrice : exitPrice - entryPrice;
                    const pnl        = priceDiff * amount * leverage - fee;
                    const marginUsed = (entryPrice * amount) / leverage;
                    const pnlPct     = marginUsed > 0 ? (pnl / marginUsed) * 100 : 0;

                    if (!Number.isFinite(pnl)) continue;

                    await prisma.trade.update({
                        where: { id: t.id },
                        data: { realizedPnl: pnl, pnlPercentage: pnlPct },
                    });
                    fixed++;
                } catch (_) { /* skip individual failures */ }
            }

            logger.info(`🔧 Repaired ${fixed}/${broken.length} trades.`);
            return fixed;
        } catch (error) {
            logger.error('Error repairing NULL P&L trades:', error);
            return 0;
        }
    }

    /**
     * Get daily P&L
     */
    async getDailyPnL(date: Date, marketType: string = 'spot') {
        try {
            const startOfDay = new Date(date);
            startOfDay.setHours(0, 0, 0, 0);

            const endOfDay = new Date(date);
            endOfDay.setHours(23, 59, 59, 999);

            const result = await prisma.trade.aggregate({
                where: {
                    status: 'closed',
                    marketType,
                    exitTime: {
                        gte: startOfDay,
                        lte: endOfDay,
                    },
                },
                _sum: { realizedPnl: true },
            });

            return result._sum.realizedPnl || 0;
        } catch (error) {
            logger.error('Error calculating daily P&L:', error);
            throw error;
        }
    }

    /**
     * Save market data
     */
    async saveMarketData(data: {
        exchange: string;
        symbol: string;
        timeframe: string;
        timestamp: Date;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }) {
        try {
            return await prisma.marketData.upsert({
                where: {
                    exchange_symbol_timeframe_timestamp: {
                        exchange: data.exchange,
                        symbol: data.symbol,
                        timeframe: data.timeframe,
                        timestamp: data.timestamp,
                    },
                },
                update: data,
                create: data,
            });
        } catch (error) {
            logger.error('Error saving market data:', error);
            return undefined;
        }
    }

    /**
     * Save trading signal
     */
    async saveSignal(data: {
        exchange: string;
        symbol: string;
        strategy: string;
        signal: string;
        confidence: number;
        price: number;
        indicators: string;
        marketType?: string;
    }) {
        try {
            return await prisma.signal.create({
                data: {
                    ...data,
                    marketType: data.marketType || 'spot'
                }
            });
        } catch (error) {
            logger.error('Error saving signal:', error);
            throw error;
        }
    }

    /**
     * Update bot state
     */
    async updateBotState(data: {
        isRunning: boolean;
        totalCapital: number;
        availableCapital: number;
        dailyPnl: number;
        dailyLoss: number;
        openPositions: number;
    }) {
        try {
            // Get or create bot state
            let botState = await prisma.botState.findFirst();

            if (!botState) {
                return await prisma.botState.create({ data });
            }

            return await prisma.botState.update({
                where: { id: botState.id },
                data: {
                    ...data,
                    lastHeartbeat: new Date(),
                },
            });
        } catch (error) {
            logger.error('Error updating bot state:', error);
            throw error;
        }
    }

    /**
     * Get closed trades that have stored entryFeatures (for own-trade AI training).
     */
    async getClosedTradesWithFeatures(limit: number = 500, marketType: string = 'futures') {
        try {
            return await prisma.trade.findMany({
                where: {
                    status: 'closed',
                    marketType,
                    NOT: { entryFeatures: null },
                    realizedPnl: { not: null },
                },
                select: { entryFeatures: true, realizedPnl: true, side: true },
                orderBy: { createdAt: 'desc' },
                take: limit,
            });
        } catch (error) {
            logger.error('Error fetching trades with features:', error);
            return [];
        }
    }

    /**
     * Get bot state
     */
    async getBotState() {
        try {
            return await prisma.botState.findFirst();
        } catch (error) {
            logger.error('Error fetching bot state:', error);
            throw error;
        }
    }
}

export const tradeRepository = new TradeRepository();
