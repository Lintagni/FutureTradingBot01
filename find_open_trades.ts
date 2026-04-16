import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const openTrades = await prisma.trade.findMany({
        where: { status: 'open' }
    });
    console.log('--- OPEN TRADES ---');
    console.log(JSON.stringify(openTrades, null, 2));
    await prisma.$disconnect();
}

main();
