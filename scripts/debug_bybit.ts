import { BybitExchange } from '../src/exchanges/BybitExchange';
import { logger } from '../src/utils/logger';

async function debugBalance() {
    try {
        console.log('--- SPOT BALANCE ---');
        const spotExchange = new BybitExchange('spot');
        const spotBalance = await spotExchange.fetchBalance('USDT');
        console.log('Spot USDT Balance:', JSON.stringify(spotBalance, null, 2));

        console.log('\n--- FUTURES BALANCE ---');
        const futuresExchange = new BybitExchange('futures');
        const futuresBalance = await futuresExchange.fetchBalance('USDT');
        console.log('Futures USDT Balance:', JSON.stringify(futuresBalance, null, 2));

        // Also check for 'USDC' just in case
        if (futuresBalance['USDC']) {
            console.log('Futures USDC Balance:', JSON.stringify(futuresBalance['USDC'], null, 2));
        }

        // Check account type
        const info = await (futuresExchange as any).exchange.privateGetV5AccountInfo();
        console.log('\nAccount Info:', JSON.stringify(info, null, 2));

    } catch (error) {
        console.error('Failed to fetch balance:', error);
    }
}

debugBalance();
