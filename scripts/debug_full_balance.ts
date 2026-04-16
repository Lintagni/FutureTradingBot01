import { BybitExchange } from '../src/exchanges/BybitExchange';

async function debugFullBalance() {
    try {
        const futuresExchange = new BybitExchange('futures');
        const balance = await (futuresExchange as any).exchange.fetchBalance();
        console.log('--- FULL BALANCE (CCXT) ---');
        console.log(JSON.stringify(balance, null, 2));

        console.log('\n--- BYBIT NATIVE ACCOUNT DATA ---');
        const raw = await (futuresExchange as any).exchange.privateGetV5AccountWalletBalance({
            accountType: 'UNIFIED'
        });
        console.log(JSON.stringify(raw, null, 2));

    } catch (error) {
        console.error('Failed to fetch balance:', error);
    }
}

debugFullBalance();
