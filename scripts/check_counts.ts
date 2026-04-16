import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const spotClosed = await prisma.trade.count({
        where: { status: 'closed', marketType: 'spot' }
    });
    const futuresClosed = await prisma.trade.count({
        where: { status: 'closed', marketType: 'futures' }
    });

    console.log(`Spot Closed Trades: ${spotClosed}`);
    console.log(`Futures Closed Trades: ${futuresClosed}`);

    const lastTrades = await prisma.trade.findMany({
        where: { status: 'closed' },
        orderBy: { entryTime: 'desc' },
        take: 5
    });
    console.log('Last 5 Closed Trades:', JSON.stringify(lastTrades, null, 2));

    await prisma.$disconnect();
}

main();
