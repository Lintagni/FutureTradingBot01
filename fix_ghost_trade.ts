import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const tradeId = '076ac7cb-0225-4a29-9ad6-1de74e4c7ba0';
    try {
        await prisma.trade.update({
            where: { id: tradeId },
            data: { status: 'closed', exitTime: new Date(), exitPrice: 0, realizedPnl: 0 }
        });
        console.log(`✅ Trade ${tradeId} marked as closed.`);

        // Also reset BotState metrics if needed
        await prisma.botState.updateMany({
            data: { openPositions: 0 } // Resetting to 0 to be safe, bot will re-count
        });
        console.log('✅ BotState metrics reset.');

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
