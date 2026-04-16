
import { BybitExchange } from '../src/exchanges/BybitExchange';
import { config } from '../src/config/trading.config';

async function checkPositions() {
    console.log('--- BYBIT POSITION CHECK ---');

    // Check Futures
    const futuresExchange = new BybitExchange('futures');
    try {
        await (futuresExchange as any).exchange.loadMarkets();
        const positions = await (futuresExchange as any).exchange.fetchPositions();
        const openPositions = positions.filter((p: any) => parseFloat(p.contracts || p.size || '0') > 0);

        console.log(`\n[FUTURES] Found ${openPositions.length} open positions:`);
        openPositions.forEach((p: any) => {
            console.log(` - ${p.symbol}: ${p.side} ${p.contracts || p.size} @ $${p.entryPrice}`);
        });
    } catch (e) {
        console.error('[FUTURES] Error:', e);
    }

    // Check Spot balances that might indicate a position
    const spotExchange = new BybitExchange('spot');
    try {
        const balance = await spotExchange.fetchBalance();
        console.log(`\n[SPOT] Tradable balances (non-dust):`);
        for (const [coin, data] of Object.entries((spotExchange as any).exchange.balance)) {
            if (coin === 'USDT' || coin === 'USDC') continue;
            const free = (data as any).free || 0;
            if (free > 0) {
                // Try to get price
                try {
                    const ticker = await spotExchange.fetchTicker(`${coin}/USDT`);
                    const value = free * ticker.last;
                    if (value > 1.0) { // Only show if value > $1
                        console.log(` - ${coin}: ${free} (Approx $${value.toFixed(2)})`);
                    }
                } catch (err) {
                    console.log(` - ${coin}: ${free} (Price unknown)`);
                }
            }
        }
    } catch (e) {
        console.error('[SPOT] Error:', e);
    }
}

checkPositions();
