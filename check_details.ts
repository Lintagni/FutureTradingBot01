import { BybitExchange } from './src/exchanges/BybitExchange';

async function checkDetails() {
    const exchange = new BybitExchange('futures');
    try {
        await (exchange as any).exchange.loadMarkets();
        const symbols = ['BNB/USDT:USDT', 'SOL/USDT:USDT'];

        for (const symbol of symbols) {
            const market = (exchange as any).exchange.market(symbol);
            console.log(`\n--- Market Details for ${symbol} ---`);
            console.log('Precision Amount:', market.precision.amount);
            console.log('Min Amount Limit:', market.limits.amount.min);
            console.log('Max Amount Limit:', market.limits.amount.max);
            console.log('Min Cost Limit:', market.limits.cost?.min);
        }

    } catch (e) {
        console.error(e);
    }
}
checkDetails();
