import { RandomForestModel } from '../src/ai/RandomForestModel';
import { logger } from '../src/utils/logger';

async function testAI() {
    logger.info('🧪 Testing AI Module...');

    const model = new RandomForestModel();

    // 1. Synthetic Data
    // Features: [RSI, MACD, Trend1, Trend2, VolRatio, Volatility]
    // Let's make "good" features clearly separable
    const features: number[][] = [];
    const labels: number[] = [];

    for (let i = 0; i < 100; i++) {
        // Class 1 (Win): High RSI, Positive MACD
        features.push([70 + Math.random() * 10, 5 + Math.random(), 1.1, 1.1, 1.5, 0.2]);
        labels.push(1);

        // Class 0 (Loss): Low RSI, Negative MACD
        features.push([30 - Math.random() * 10, -5 - Math.random(), 0.9, 0.9, 0.5, 0.2]);
        labels.push(0);
    }

    logger.info(`Generated ${features.length} synthetic samples.`);

    // 2. Train
    model.train(features, labels);
    logger.info('✅ Training function execution successful');

    // 3. Predict
    // Test a "Win" case
    const winCase = [75, 5.5, 1.1, 1.1, 1.5, 0.2];
    const winPrediction = model.predict(winCase);
    const winProb = model.predictProbability(winCase);
    logger.info(`🔮 Prediction for Win Case: Class ${winPrediction}, Prob: ${(winProb * 100).toFixed(6)}%`);

    // Test a "Loss" case
    const lossCase = [25, -5.5, 0.9, 0.9, 0.5, 0.2];
    const lossPrediction = model.predict(lossCase);
    const lossProb = model.predictProbability(lossCase);
    logger.info(`🔮 Prediction for Loss Case: Class ${lossPrediction}, Prob: ${(lossProb * 100).toFixed(6)}%`);

    // Validation: Win Case should be >= 0.6 (due to safeguard), Loss Case should be <= 0.4
    if (winProb >= 0.6 && lossProb <= 0.4) {
        logger.info('✅ AI Logic Verified: Correctly separates classes.');
    } else {
        logger.error('❌ AI Logic Verification Failed: Predictions not distinct enough.');
        process.exit(1);
    }
}

testAI();
