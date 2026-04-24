import dotenv from 'dotenv';

dotenv.config();

export const config = {
    // Trading Mode
    mode: process.env.TRADING_MODE || 'paper', // 'paper' or 'live'

    // Exchange Configuration
    exchange: {
        name: 'bybit',
        apiKey: process.env.BYBIT_API_KEY || '',
        apiSecret: process.env.BYBIT_API_SECRET || '',
        testnet: process.env.TRADING_MODE === 'paper',
    },

    // Trading Pairs (fallback/seed — used before first MarketScanner scan)
    tradingPairs: (process.env.TRADING_PAIRS || 'BTC/USDT,ETH/USDT').split(','),

    // Auto Pair Selection
    autoPairSelection: process.env.AUTO_PAIR_SELECTION === 'true',

    // Market Scanner Configuration
    scanner: {
        maxActivePairs: parseInt(process.env.MAX_ACTIVE_PAIRS || '3'),
        scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || '5'),
        minDailyVolumeUSD: parseFloat(process.env.MIN_DAILY_VOLUME || '5000000'),
        minPrice: parseFloat(process.env.MIN_PAIR_PRICE || '1.0'),
        candidatePoolSize: 20, // Top N by volume to evaluate
    },

    // Timeframe
    timeframe: process.env.TIMEFRAME || '15m', // 1m, 5m, 15m, 1h, 4h, 1d

    // Risk Management
    risk: {
        maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '50'),
        minPositionSize: parseFloat(process.env.MIN_POSITION_SIZE || '6'),
        maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '200'),
        stopLossPercentage: parseFloat(process.env.STOP_LOSS_PERCENTAGE || '3.5'),
        takeProfitPercentage: parseFloat(process.env.TAKE_PROFIT_PERCENTAGE || '4.5'),
        maxOpenPositions: 3,
        positionSizePercentage: 0.02, // legacy fallback — tiers override this
    },

    // Capital-Adaptive Tiers — bot auto-scales as balance grows
    capitalTiers: [
        { name: 'micro',  maxBalance: 50,       positionPct: 0.45, leverage: 2, minScannerPrice: 0.001 },
        { name: 'small',  maxBalance: 200,       positionPct: 0.20, leverage: 2, minScannerPrice: 0.5 },
        { name: 'medium', maxBalance: 1000,      positionPct: 0.08, leverage: 3, minScannerPrice: 1.0 },
        { name: 'large',  maxBalance: Infinity,  positionPct: 0.03, leverage: 3, minScannerPrice: 1.0 },
    ],

    // Strategy Parameters
    strategy: {
        // EMA Settings
        emaShort: parseInt(process.env.EMA_SHORT || '9'),
        emaLong: parseInt(process.env.EMA_LONG || '21'),

        // RSI Settings
        rsiPeriod: parseInt(process.env.RSI_PERIOD || '14'),
        rsiOversold: parseInt(process.env.RSI_OVERSOLD || '30'),
        rsiOverbought: parseInt(process.env.RSI_OVERBOUGHT || '70'),

        // MACD Settings
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,

        // Bollinger Bands
        bbPeriod: 20,
        bbStdDev: 2,

        // Volume
        volumeMultiplier: 1.5, // Signal requires 1.5x average volume

        // ML Confidence Threshold
        mlConfidenceThreshold: 0.55, // Raised from 0.45 — stricter filter to reduce bad trades

        // Adaptive Learning Thresholds
        minConfidence: 0.40,       // Raised from 0.30
        defensiveConfidence: 0.50, // Raised from 0.40

        // ATR Settings for Dynamic SL/TP
        atrMultiplierSL: 2.0,
        atrMultiplierTP: 4.0, // Raised from 3.0 — R:R now 1:2, breakeven drops to 33.3%

        // Trailing Stop Settings
        trailingStopActivation: 1.5, // Activate trailing stop at +1.5% profit
        trailingStopDistance: 1.0,    // Trail 1% behind highest price
        breakEvenActivation: 1.0,    // Move SL to breakeven at +1% profit

        // Smart Profit Exit
        smartTakeProfitMin: 1.0,      // % minimum profit to consider early exit
        smartTakeProfitPullback: 0.3,  // % pullback from high to trigger exit

        // Stale Position Timeout (hours)
        stalePositionHours: 6,
        stalePositionMinProfit: -0.5, // % — only force-exit if in loss (was 0.5; slow-but-correct trades no longer punished)

        // Loss Cooldown
        consecutiveLossCooldown: 2,  // After N consecutive losses
        cooldownCycles: 3,           // Skip N analysis cycles
    },

    // Notifications
    notifications: {
        telegram: {
            enabled: !!process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== 'your_telegram_bot_token',
            botToken: process.env.TELEGRAM_BOT_TOKEN || '',
            chatId: process.env.TELEGRAM_CHAT_ID || '',
        },
        discord: {
            enabled: !!process.env.DISCORD_WEBHOOK_URL && process.env.DISCORD_WEBHOOK_URL !== 'your_discord_webhook_url',
            webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
        },
    },


    // Futures Settings
    futures: {
        leverage: parseInt(process.env.FUTURES_LEVERAGE || '3'),
        marginMode: (process.env.FUTURES_MARGIN_MODE || 'isolated') as 'isolated' | 'cross',
    },

    // Logging
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        console: true,
        file: true,
    },

    // Database
    database: {
        url: process.env.DATABASE_URL || 'file:./trading.db',
    },

    // Backtesting
    backtest: {
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        initialCapital: 10000,
    },
};

// Validation
export function validateConfig(): void {
    if (config.mode === 'live') {
        if (!config.exchange.apiKey || !config.exchange.apiSecret) {
            throw new Error('API keys are required for live trading mode');
        }
        console.warn('⚠️  LIVE TRADING MODE - Real money will be used!');
    } else {
        console.log('📝 PAPER TRADING MODE - Simulation only');
    }

    if (config.risk.maxPositionSize <= 0) {
        throw new Error('Max position size must be greater than 0');
    }

    if (config.tradingPairs.length === 0) {
        throw new Error('At least one trading pair must be specified');
    }

    console.log('✅ Configuration validated successfully');
}
