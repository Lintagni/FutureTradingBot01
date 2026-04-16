import { BybitExchange } from './src/exchanges/BybitExchange';
import { config } from './src/config/trading.config';

async function diagnose() {
    const exchange = new BybitExchange('futures');
    const symbol = 'BNB/USDT';

    try {
        console.log('--- MARKET DATA ---');
        await (exchange as any).exchange.loadMarkets();
        const market = (exchange as any).exchange.market(symbol);
        console.log('Market Limits:', JSON.stringify(market.limits, null, 2));
        console.log('Precision:', JSON.stringify(market.precision, null, 2));

        console.log('\n--- ACCOUNT POSITION MODE ---');
        const posMode = await (exchange as any).exchange.privateGetV5PositionList({
            category: 'linear',
            symbol: symbol.replace('/', '')
        });
        console.log('Position Mode Info:', JSON.stringify(posMode, null, 2));

        console.log('\n--- ACCOUNT CONFIG ---');
        const accInfo = await (exchange as any).exchange.privateGetV5AccountInfo();
        console.log('Account Info:', JSON.stringify(accInfo, null, 2));

    } catch (error) {
        console.error('❌ Diagnostics failed:', error);
    }
}

diagnose();
