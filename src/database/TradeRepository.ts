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
    leverage?: number; // Futures leverage (e.g. 3 for 3x)
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
            return result._sum.realizedPnl || 0;
        } catch (error) {
            logger.error('Error calculating total P&L:', error);
            throw error;
        }
    }

    /**
     * Get Lifetime Win Rate
     */
    async getLifetimeWinRate(marketType: string = 'spot') {
        try {
            const totalClosed = await prisma.trade.count({
                where: {
                    status: 'closed',
                    marketType,
                    realizedPnl: { not: 0 } // Exclude breakeven
                }
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
