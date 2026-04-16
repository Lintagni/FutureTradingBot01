import { aiModel } from './src/ai/RandomForestModel';
import { logger } from './src/utils/logger';

async function verify() {
    logger.info('🔍 Verifying AI Model probabilities...');
    const loaded = aiModel.load();
    if (!loaded) {
        logger.error('❌ Failed to load model');
        return;
    }

    // Dummy features: [RSI, MACD_Hist, Price/EMA21, Price/EMA9, Volume/AvgVolume, BandWidth, ADX]
    const testCases = [
        [30, 0.5, 0.98, 0.99, 2.0, 0.05, 30], // Bullish
        [70, -0.5, 1.02, 1.01, 0.5, 0.05, 15], // Bearish
        [50, 0, 1.0, 1.0, 1.0, 0.02, 20],      // Neutral
        [20, 1.5, 0.95, 0.96, 5.0, 0.10, 60],  // Strong Bullish Oversold
        [85, -1.5, 1.05, 1.04, 3.0, 0.10, 55], // Strong Bearish Overbought
    ];

    for (let i = 0; i < testCases.length; i++) {
        const features = testCases[i];
        const prob = aiModel.predictProbability(features);
        logger.info(`Test Case ${i + 1}: prob=${(prob * 100).toFixed(1)}%`);
    }

    logger.info('✅ Verification complete.');
}

verify().catch(console.error);
