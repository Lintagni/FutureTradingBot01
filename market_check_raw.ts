import { BybitExchange } from './src/exchanges/BybitExchange';

async function check() {
    const exchange = new BybitExchange('futures');
    const symbol = 'BNB/USDT';
    try {
        await (exchange as any).exchange.loadMarkets();
        const market = (exchange as any).exchange.market(symbol);
        console.log('--- MARKET INFO (BYBIT RAW) ---');
        console.log('Qty Step:', market.info?.lotSizeFilter?.qtyStep);
        console.log('Min Qty:', market.info?.lotSizeFilter?.minOrderQty);
        console.log('CCXT Precision Amount:', market.precision.amount);
    } catch (e) {
        console.error(e);
    }
}
check();
