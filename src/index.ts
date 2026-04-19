import { TradingEngine } from './core/TradingEngine';
import { BybitExchange } from './exchanges/BybitExchange';
import { TrendFollowingStrategy } from './strategies/TrendFollowingStrategy';
import { validateConfig } from './config/trading.config';
import { logger } from './utils/logger';
import { prisma } from './database/TradeRepository';
import { notifier } from './utils/notifier';
import { autoRetrainer } from './ai/AutoRetrainer';
import { webServer } from './utils/WebServer';

async function main() {
    try {
        // Validate configuration
        validateConfig();

        // Initialize database
        logger.info('Initializing database...');
        await prisma.$connect();
        logger.info('✅ Database connected');

        // Create futures exchange instance
        logger.info('Initializing exchange (Bybit Futures)...');
        const exchange = new BybitExchange('futures');

        // Test connection (non-fatal — bot logs the real error and continues)
        const connected = await exchange.testConnection();
        if (!connected) {
            logger.warn('⚠️  Exchange connection check failed — check API keys and network. Bot will attempt to continue.');
        } else {
            logger.info('✅ Exchange connected');
        }

        // Create strategy instance
        const strategy = new TrendFollowingStrategy();

        // Create the futures engine
        logger.info('Initializing Futures Engine...');
        const futuresEngine = new TradingEngine(exchange, strategy);

        // Register Telegram commands
        notifier.registerBotCommands({
            onStart: async () => {
                await futuresEngine.start();
            },
            onStop: (reason) => {
                futuresEngine.stop(reason);
            },
            onStatus: async () => {
                return await futuresEngine.getStatus();
            },
            onAnalyze: (symbol) => futuresEngine.getMarketAnalysis(symbol),
            onAddPair: async (symbol) => {
                return await futuresEngine.addPair(symbol);
            },
            onRemovePair: async (symbol) => {
                return await futuresEngine.removePair(symbol);
            },
            onUpdateMinSize: async (size) => {
                return await futuresEngine.updateMinPositionSize(size);
            },
            onGetMinSize: () => {
                return futuresEngine.getMinPositionSize();
            },
            onScannerStatus: async () => {
                return await futuresEngine.getScannerStatus();
            },
            onForceRescan: async () => {
                return await futuresEngine.forceRescan();
            },
            onGetActivePairs: () => {
                return futuresEngine.getActivePairs();
            },
            onForceRetrain: async () => {
                return await autoRetrainer.forceRetrain();
            }
        });

        // Start Web Dashboard immediately so port 8080 is up before Fly health checks
        webServer.start();

        // Start engine
        await futuresEngine.start();

        // Start AI auto-retrainer (every 12 hours)
        autoRetrainer.start();

        // Notify startup
        await notifier.notifyBotStarted();

        // Connect live engine data to dashboard
        webServer.registerEngine(futuresEngine);

        // Keep the process running
        logger.info('Trading bot is running. Press Ctrl+C to stop.');

        // Optional: Daily summary at midnight
        const scheduleDailySummary = () => {
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(0, 0, 0, 0);

            const msUntilMidnight = tomorrow.getTime() - now.getTime();

            setTimeout(async () => {
                // Send daily summary (implement this in notifier if needed)
                logger.info('Sending daily summary...');
                scheduleDailySummary(); // Schedule next day
            }, msUntilMidnight);
        };

        scheduleDailySummary();

    } catch (error) {
        logger.error('Fatal error:', error);
        await prisma.$disconnect();
        process.exit(1);
    }
}

// Run the bot
main();
