import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function lastTrades() {
    try {
        const trades = await prisma.trade.findMany({
            take: 10,
            orderBy: {
                updatedAt: 'desc'
            }
        });

        console.log('--- LAST 10 TRADES IN DB ---');
        trades.forEach(t => {
            console.log(` - [${t.marketType}] ${t.symbol}: ${t.side} ${t.amount} (Status: ${t.status}, Updated: ${t.updatedAt.toISOString()})`);
        });

    } catch (error) {
        console.error('Error fetching trades:', error);
    } finally {
        await prisma.$disconnect();
    }
}

lastTrades();
