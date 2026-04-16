import { BybitExchange } from './src/exchanges/BybitExchange';

async function test() {
    const exchange = new BybitExchange('futures');
    const symbol = 'BNB/USDT';

    const amounts = [0.0163, 0.016, 0.02, 0.01];
    const params = { category: 'linear' };

    for (const amount of amounts) {
        try {
            console.log(`🚀 Testing amount: ${amount}...`);
            const order = await (exchange as any).exchange.createMarketSellOrder(symbol, amount, params);
            console.log(`✅ Success for ${amount}! OrderId: ${order.id}`);
            // Close immediately
            await (exchange as any).exchange.createMarketBuyOrder(symbol, amount, params);
            break; // Stop if we find one that works
        } catch (e: any) {
            console.error(`❌ Failed for ${amount}: ${e.message}`);
        }
    }
}
test();
