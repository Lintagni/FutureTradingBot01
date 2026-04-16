import { BybitExchange } from '../exchanges/BybitExchange';
import { config } from '../config/trading.config';
import dotenv from 'dotenv';
import path from 'path';

// Parse .env manually to ensure it's loaded for this script if run directly
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function verifyConnection() {
    try {
        console.log('🔐 Verifying Bybit API Connection...');
        console.log(`Mode: ${config.mode.toUpperCase()}`);
        console.log(`Exchange: ${config.exchange.name}`);

        const exchange = new BybitExchange();

        // 1. Test basic connectivity
        process.stdout.write('1. Testing connectivity... ');
        const connected = await exchange.testConnection();
        if (connected) {
            console.log('✅ Connected');
        } else {
            console.log('❌ Failed');
            process.exit(1);
        }

        // 2. Test fetching balance (requires valid API keys)
        process.stdout.write('2. Verifying API keys (Fetch Balance)... ');
        try {
            const balance = await exchange.fetchBalance();
            console.log('✅ Valid Keys');
            console.log(`   💰 Available Balance: ${balance.free.toFixed(2)} USDT`);
            console.log(`   chk Total Balance: ${balance.total.toFixed(2)} USDT`);
        } catch (error: any) {
            console.log('❌ Invalid Keys or Permissions');
            console.error('   Error:', error.message);
            process.exit(1);
        }

        console.log('\n✨ All checks passed! You are ready to trade.');
        process.exit(0);

    } catch (error: any) {
        console.error('\n❌ Unexpected Error:', error.message);
        process.exit(1);
    }
}

verifyConnection();
