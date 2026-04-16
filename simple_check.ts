import { BybitExchange } from './src/exchanges/BybitExchange';

async function check() {
    const exchange = new BybitExchange('futures');
    const symbol = 'BNB/USDT';
    try {
        await (exchange as any).exchange.loadMarkets();
        const market = (exchange as any).exchange.market(symbol);
        console.log('SYMBOL:', symbol);
        console.log('MIN AMOUNT:', market.limits.amount.min);
        console.log('MIN COST:', market.limits.cost?.min);

        const ticker = await (exchange as any).exchange.fetchTicker(symbol);
        console.log('LAST PRICE:', ticker.last);
        console.log('MIN ORDER VALUE (USD):', market.limits.amount.min * ticker.last);
    } catch (e) {
        console.error(e);
    }
}
check();
