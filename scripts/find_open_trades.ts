import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function findOpenTrades() {
    try {
        const openTrades = await prisma.trade.findMany({
            where: {
                status: 'open'
            }
        });

        console.log(`Found ${openTrades.length} OPEN trades in DB:`);
        openTrades.forEach(t => {
            console.log(` - [${t.marketType}] ${t.symbol}: ${t.side} ${t.amount} (ID: ${t.id})`);
        });

    } catch (error) {
        console.error('Error finding open trades:', error);
    } finally {
        await prisma.$disconnect();
    }
}

findOpenTrades();
