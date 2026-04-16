import { BybitExchange } from '../src/exchanges/BybitExchange';

async function listBalanceKeys() {
    try {
        const futuresExchange = new BybitExchange('futures');
        const balance = await (futuresExchange as any).exchange.fetchBalance();
        console.log('Balance Keys:', Object.keys(balance).join(', '));

        if (balance['USDT']) {
            console.log('USDT details:', JSON.stringify(balance['USDT'], null, 2));
        }

        // Check for 'info' which contains the raw response
        if (balance.info && balance.info.result && balance.info.result.list) {
            console.log('Account Type from Info:', balance.info.result.list[0].accountType);
        }

    } catch (error) {
        console.error('Failed to fetch balance:', error);
    }
}

listBalanceKeys();
