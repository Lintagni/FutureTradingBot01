import { BybitExchange } from './src/exchanges/BybitExchange';
import { config } from './src/config/trading.config';

async function main() {
    const exchange = new BybitExchange('futures');
    try {
        await (exchange as any).exchange.loadMarkets();
        const balance = await (exchange as any).exchange.fetchBalance();
        console.log('--- CCXT BALANCE ---');
        console.log('USDT Free:', balance.USDT?.free);
        console.log('USDT Used:', balance.USDT?.used);
        console.log('USDT Total:', balance.USDT?.total);

        console.log('\n--- BYBIT INFO ---');
        if (balance.info?.result?.list?.[0]) {
            const acc = balance.info.result.list[0];
            console.log('Account Type:', acc.accountType);
            const usdt = acc.coin?.find((c: any) => c.coin === 'USDT');
            if (usdt) {
                console.log('USDT Wallet Balance:', usdt.walletBalance);
                console.log('USDT Available to Withdraw:', usdt.availableToWithdraw);
                console.log('USDT Equity:', usdt.equity);
            }
        }
    } catch (e) {
        console.error(e);
    }
}

main();
