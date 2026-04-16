
import { PrismaClient } from '@prisma/client';
import { BybitExchange } from '../src/exchanges/BybitExchange';
import { config } from '../src/config/trading.config';

const prisma = new PrismaClient();

async function syncPositions() {
    console.log('--- 🔄 SYNCING BYBIT FUTURES -> DATABASE ---');

    const exchange = new BybitExchange('futures');
    try {
        await (exchange as any).exchange.loadMarkets();
        const apiPositions = await (exchange as any).exchange.fetchPositions();
        const openPositions = apiPositions.filter((p: any) => parseFloat(p.contracts || p.size || '0') > 0);

        console.log(`\nBYBIT: Found ${openPositions.length} open futures positions.`);

        for (const pos of openPositions) {
            const symbol = pos.symbol.replace(':USDT', '');
            const side = pos.side.toLowerCase() === 'long' ? 'buy' : 'sell';
            const amount = parseFloat(pos.contracts || pos.size);
            const entryPrice = parseFloat(pos.entryPrice);

            console.log(`\nChecking ${symbol} (${side}) on DB...`);

            // 1. Look for existing EXACT match in Futures
            const existingFutures = await prisma.trade.findFirst({
                where: {
                    symbol: symbol,
                    marketType: 'futures',
                    status: 'open'
                }
            });

            if (existingFutures) {
                console.log(`✅ Already correctly recorded in DB (ID: ${existingFutures.id})`);
                continue;
            }

            // 2. Look for "Ghost" Spot trade for the same symbol
            const ghostSpot = await prisma.trade.findFirst({
                where: {
                    symbol: symbol,
                    marketType: 'spot',
                    status: 'open'
                }
            });

            if (ghostSpot) {
                console.log(`⚠️ Found GHOST SPOT trade for ${symbol}. Converting to Futures...`);
                await prisma.trade.update({
                    where: { id: ghostSpot.id },
                    data: {
                        marketType: 'futures',
                        amount: amount, // Sync exact amount from exchange
                        entryPrice: entryPrice, // Sync exact price
                        cost: amount * entryPrice,
                        side: side // Use exchange side
                    }
                });
                console.log(`✅ Converted and updated DB ID: ${ghostSpot.id}`);
                continue;
            }

            // 3. Create new record if none found
            console.log(`➕ No record found for ${symbol}. Creating new Futures entry...`);
            await prisma.trade.create({
                data: {
                    exchange: 'bybit',
                    symbol: symbol,
                    side: side,
                    type: 'market',
                    amount: amount,
                    price: entryPrice,
                    cost: amount * entryPrice,
                    fee: 0,
                    entryPrice: entryPrice,
                    entryTime: new Date(),
                    status: 'open',
                    marketType: 'futures',
                    strategy: 'Imported',
                    signal: side
                }
            });
            console.log(`✅ Created new record.`);
        }

        // 4. Check for Orphan Trades (Open in DB but closed on Bybit)
        const dbTrades = await prisma.trade.findMany({
            where: { status: 'open', marketType: 'futures' }
        });

        for (const dbTrade of dbTrades) {
            const stillOpen = openPositions.find((p: any) => p.symbol.startsWith(dbTrade.symbol));
            if (!stillOpen) {
                console.log(`\n⚠️ Trade ${dbTrade.symbol} (ID: ${dbTrade.id}) is open in DB but CLOSED on Bybit.`);
                console.log(`Closing in DB as 'Sync Closed'...`);
                await prisma.trade.update({
                    where: { id: dbTrade.id },
                    data: {
                        status: 'closed',
                        exitPrice: 0, // Unknown
                        exitTime: new Date(),
                        realizedPnl: 0,
                        pnlPercentage: 0
                    }
                });
            }
        }

    } catch (error) {
        console.error('❌ Sync failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

syncPositions();
