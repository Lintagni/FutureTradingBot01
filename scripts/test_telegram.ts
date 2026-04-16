
import { notifier } from '../src/utils/notifier';

async function main() {
    console.log('Testing Telegram Notification...');
    // We send a direct message. Note: notifier catches errors and logs them, 
    // so we look at the console output for errors.
    await notifier.sendTelegramMessage('🔔 *Test Message* from verification script.\nIf you see this, Telegram is configured correctly!');
    console.log('Test function executed. Check for error logs above.');
}

main().catch(console.error);
