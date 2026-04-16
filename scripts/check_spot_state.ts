import { BybitExchange } from '../src/exchanges/BybitExchange';

async function checkActualSpotState() {
    try {
        const spotExchange = new BybitExchange('spot');
        const ccxt = (spotExchange as any).exchange;

        console.log('--- CHECKING OPEN SPOT ORDERS ---');
        const openOrders = await ccxt.fetchOpenOrders();
        console.log(`Found ${openOrders.length} open orders:`);
        openOrders.forEach((o: any) => {
            console.log(` - ${o.symbol}: ${o.side} ${o.amount} @ ${o.price} (${o.status})`);
        });

        console.log('\n--- CHECKING SPOT BALANCES (NON-ZERO) ---');
        const balance = await ccxt.fetchBalance();
        const nonZero = Object.entries(balance.total)
            .filter(([coin, qty]: [string, any]) => qty > 0 && coin !== 'USDT')
            .map(([coin, qty]) => `${coin}: ${qty} (Free: ${balance.free[coin] || 0}, Used: ${balance.used[coin] || 0})`);

        if (nonZero.length === 0) {
            console.log('No non-USDT coins found with balance > 0');
        } else {
            nonZero.forEach(line => console.log(` - ${line}`));
        }

    } catch (error) {
        console.error('Failed to check spot state:', error);
    }
}

checkActualSpotState();
