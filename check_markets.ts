import { BybitExchange } from './src/exchanges/BybitExchange';

async function checkMarkets() {
    const exchange = new BybitExchange('futures');
    try {
        await (exchange as any).exchange.loadMarkets();
        const symbol = 'BNB/USDT';
        const market = (exchange as any).exchange.market(symbol);

        console.log('--- Market Info for BNB/USDT ---');
        console.log('Symbol:', market.symbol);
        console.log('ID:', market.id);
        console.log('Type:', market.type);
        console.log('Swap:', market.swap);
        console.log('Spot:', market.spot);
        console.log('Linear:', market.linear);
        console.log('Category (info):', market.info?.category);

        // Check if there are other BNB/USDT markers
        const allSymbols = Object.keys((exchange as any).exchange.markets);
        const matches = allSymbols.filter(s => s.startsWith('BNB/USDT'));
        console.log('\n--- All matching symbols ---');
        console.log(matches);

        for (const m of matches) {
            const details = (exchange as any).exchange.market(m);
            console.log(`${m}: type=${details.type}, id=${details.id}`);
        }

    } catch (e) {
        console.error(e);
    }
}
checkMarkets();
