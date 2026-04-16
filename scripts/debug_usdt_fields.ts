import { BybitExchange } from '../src/exchanges/BybitExchange';

async function debugUsdtFields() {
    try {
        const futuresExchange = new BybitExchange('futures');
        const balance = await (futuresExchange as any).exchange.fetchBalance();

        const accInfo = balance.info.result.list[0];
        const usdt = accInfo.coin.find((c: any) => c.coin === 'USDT');

        console.log('--- NATIVE USDT FIELDS ---');
        console.log(JSON.stringify(usdt, null, 2));

    } catch (error) {
        console.error('Failed to fetch balance:', error);
    }
}

debugUsdtFields();
