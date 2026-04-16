import { BybitExchange } from './src/exchanges/BybitExchange';
import { config } from './src/config/trading.config';

async function testShort() {
    const exchange = new BybitExchange('futures');
    const symbol = 'BNB/USDT';
    const amount = 0.01; // Tiny amount

    try {
        console.log(`🚀 Testing SHORT order for ${symbol} with ${amount} BNB...`);
        // Ensure leverage and margin mode are set
        await exchange.setMarginMode(symbol, 'isolated');
        await exchange.setLeverage(symbol, 5);

        const order = await exchange.createMarketSellOrder(symbol, amount);
        console.log('✅ Short order successful:', JSON.stringify(order, null, 2));

        // Immediately close it
        console.log('🔄 Closing test short position...');
        const closeOrder = await exchange.createMarketBuyOrder(symbol, amount);
        console.log('✅ Close successful:', JSON.stringify(closeOrder, null, 2));

    } catch (error) {
        console.error('❌ Short test failed:', error);
    }
}

testShort();
