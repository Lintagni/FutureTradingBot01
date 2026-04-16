import { BybitExchange } from './src/exchanges/BybitExchange';

async function check() {
    const exchange = new BybitExchange('futures');
    const symbol = 'BNB/USDT';
    try {
        await (exchange as any).exchange.loadMarkets();
        const market = (exchange as any).exchange.market(symbol);
        console.log('--- PRECISION DATA ---');
        console.log('Amount Precision:', market.precision.amount);
        console.log('Price Precision:', market.precision.price);

        console.log('\n--- TESTS ---');
        console.log('0.016321 ->', (exchange as any).exchange.amountToPrecision(symbol, 0.016321));
    } catch (e) {
        console.error(e);
    }
}
check();
