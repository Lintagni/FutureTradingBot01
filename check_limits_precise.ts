import { BybitExchange } from './src/exchanges/BybitExchange';

async function checkLimits() {
    const exchange = new BybitExchange('futures');
    const symbols = ['BNB/USDT', 'SOL/USDT'];
    for (const symbol of symbols) {
        try {
            await (exchange as any).exchange.loadMarkets();
            const market = (exchange as any).exchange.market(symbol);
            console.log(`--- LIMITS FOR ${symbol} ---`);
            console.log('Min Amount:', market.limits.amount.min);
            console.log('Min Cost:', market.limits.cost?.min);
            console.log('Precision Amount:', market.precision.amount);

            const currentPrice = (await (exchange as any).exchange.fetchTicker(symbol)).last;
            console.log('Current Price:', currentPrice);
            console.log('Value of Min Amount:', market.limits.amount.min * currentPrice);
            console.log('\n');
        } catch (e) {
            console.error(`Error for ${symbol}:`, e);
        }
    }
}

checkLimits();
