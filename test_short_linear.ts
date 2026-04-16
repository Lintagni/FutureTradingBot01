import { BybitExchange } from './src/exchanges/BybitExchange';
import { config } from './src/config/trading.config';

async function testShortLinear() {
    const exchange = new BybitExchange('futures');
    const symbol = 'BNB/USDT';
    const amount = 0.01;

    try {
        console.log(`🚀 Testing SHORT order with CATEGORY: 'LINEAR'...`);

        // CCXT V5 Bybit params
        const params = {
            category: 'linear'
        };

        const order = await (exchange as any).exchange.createMarketSellOrder(symbol, amount, params);
        console.log('✅ Short order successful:', JSON.stringify(order, null, 2));

        // Close it
        console.log('🔄 Closing test short position...');
        const closeOrder = await (exchange as any).exchange.createMarketBuyOrder(symbol, amount, params);
        console.log('✅ Close successful:', JSON.stringify(closeOrder, null, 2));

    } catch (error) {
        console.error('❌ Short test failed:', error);
    }
}

testShortLinear();
