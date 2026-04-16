import { BybitExchange } from './src/exchanges/BybitExchange';

async function testTimeSync() {
    const exchange = new BybitExchange('spot');

    console.log('--- Initial Connection and Sync ---');
    const connected = await exchange.testConnection();
    console.log('Connected:', connected);

    const ccxtExchange = (exchange as any).exchange;
    const initialDiff = (ccxtExchange as any).timeDifference;
    console.log('Initial time difference:', initialDiff, 'ms');

    console.log('\n--- Checking Server Time vs Local Adjusted Time ---');
    try {
        const serverTime = await ccxtExchange.fetchTime();
        const adjustedTime = ccxtExchange.milliseconds();
        const diff = adjustedTime - serverTime;

        console.log('Server Time:', serverTime);
        console.log('Adjusted Time:', adjustedTime);
        console.log('Difference (Adjusted - Server):', diff, 'ms');

        if (diff > 0) {
            console.log('⚠️ Adjusted time is AHEAD of server time. If > 1000ms, this is risky.');
        } else {
            console.log('✅ Adjusted time is BEHIND or SYNCED with server time.');
        }

        // Test a private call (fetchBalance)
        console.log('\n--- Testing Private API Call (fetchBalance) ---');
        const balance = await exchange.fetchBalance();
        console.log('Balance successfully fetched:', !!balance);

    } catch (error: any) {
        console.error('❌ Error testing time sync:', error.message);
        if (error.message.includes('10002')) {
            console.error('Detected Bybit Time Error (10002)!');
        }
    }
}

testTimeSync();
