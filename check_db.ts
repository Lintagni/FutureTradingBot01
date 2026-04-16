import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        console.log('Checking Signal table...');
        const latestSignals = await prisma.signal.findMany({
            orderBy: { createdAt: 'desc' },
            take: 5
        });
        console.log('Latest Signals:', JSON.stringify(latestSignals, null, 2));

        console.log('\nChecking Trade table...');
        const latestTrades = await prisma.trade.findMany({
            orderBy: { createdAt: 'desc' },
            take: 5
        });
        console.log('Latest Trades:', JSON.stringify(latestTrades, null, 2));

        console.log('\nChecking BotState table...');
        const botState = await prisma.botState.findFirst();
        console.log('Bot State:', JSON.stringify(botState, null, 2));

    } catch (error) {
        console.error('Error querying database:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
