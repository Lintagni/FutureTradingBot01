import { BybitExchange } from '../src/exchanges/BybitExchange';

async function checkLimits() {
    try {
        const futuresExchange = new BybitExchange('futures');
        await (futuresExchange as any).exchange.loadMarkets();
        const market = (futuresExchange as any).exchange.market('BNB/USDT:USDT');
        console.log('BNB/USDT:USDT Market Limits:', JSON.stringify(market.limits, null, 2));
        console.log('BNB/USDT:USDT Market Precision:', JSON.stringify(market.precision, null, 2));

        // Also check how CCXT formats 0.007924
        const formatted = (futuresExchange as any).exchange.amountToPrecision('BNB/USDT:USDT', 0.007924);
        console.log('Formatted Amount (0.007924):', formatted);

    } catch (error) {
        console.error('Failed to fetch limits:', error);
    }
}

checkLimits();
