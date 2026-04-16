import { RandomForestClassifier as RFClassifier } from 'ml-random-forest';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export class RandomForestModel {
    private model: RFClassifier | null = null;
    private modelPath: string;

    constructor() {
        // Ensure models directory exists
        const modelDir = path.join(process.cwd(), 'models');
        if (!fs.existsSync(modelDir)) {
            fs.mkdirSync(modelDir, { recursive: true });
        }
        this.modelPath = path.join(modelDir, 'random_forest.json');
    }

    /**
     * Train the model with features and labels
     * @param features Array of feature arrays (e.g. [[rsi, macd, ...], ...])
     * @param labels Array of labels (0 or 1)
     */
    train(features: number[][], labels: number[]): void {
        const options = {
            seed: 42,
            maxFeatures: 0.8,
            replacement: true,
            nEstimators: 50 // Number of trees
        };

        this.model = new RFClassifier(options);
        this.model.train(features, labels);
        logger.info(`🧠 Model trained with ${features.length} samples.`);
    }

    /**
     * Predict the class (0 or 1)
     */
    predict(features: number[]): number {
        if (!this.model) return 0;
        return this.model.predict([features])[0];
    }

    /**
     * Predict the probability of success (class 1)
     * Uses perturbation-based confidence estimation for reliable probability.
     * 
     * How it works:
     * 1. Get the base prediction from the full ensemble (always works)
     * 2. Create slightly perturbed versions of the input features
     * 3. Count how many perturbations flip the prediction
     * 4. More flips = less confident = probability closer to 0.5
     *    Fewer flips = more confident = probability closer to 0 or 1
     * 
     * @param features Feature array for a single sample
     * @returns Probability of success (0 to 1)
     */
    predictProbability(features: number[]): number {
        if (!this.model) {
            logger.warn('🧠 Model not trained or loaded. Returning default 0.5');
            return 0.5;
        }

        try {
            // Step 1: Get base prediction from the full ensemble (this always works)
            const basePrediction = this.model.predict([features])[0];

            // Step 2: Perturbation-based confidence estimation
            // Test how stable the prediction is across nearby feature values
            const NUM_PERTURBATIONS = 30;
            const PERTURBATION_SCALE = 0.05; // 5% noise
            let agreementCount = 0;

            for (let i = 0; i < NUM_PERTURBATIONS; i++) {
                const perturbed = features.map((f) => {
                    if (f === 0) return f; // Don't perturb zero values
                    // Add small random noise proportional to feature magnitude
                    const noise = f * PERTURBATION_SCALE * (Math.random() * 2 - 1);
                    return f + noise;
                });

                const perturbedPrediction = this.model.predict([perturbed])[0];
                if (perturbedPrediction === basePrediction) {
                    agreementCount++;
                }
            }

            // Step 3: Convert agreement ratio to probability
            // If basePrediction = 1 (win):  high agreement → probability near 1.0
            // If basePrediction = 0 (loss): high agreement → probability near 0.0
            const agreementRatio = agreementCount / NUM_PERTURBATIONS;
            // Map agreement from [0.5, 1.0] to confidence [0.0, 1.0]
            // (below 50% agreement means prediction is basically random)
            const confidence = Math.max(0, (agreementRatio - 0.5) * 2);

            let probability: number;
            if (basePrediction === 1) {
                // Win prediction: probability ranges from 0.5 (uncertain) to 0.95 (very confident)
                probability = 0.5 + confidence * 0.45;
            } else {
                // Loss prediction: probability ranges from 0.5 (uncertain) to 0.05 (very confident loss)
                probability = 0.5 - confidence * 0.45;
            }

            probability = Math.max(0.05, Math.min(0.95, probability));

            logger.debug(`🧠 AI Detail: base=${basePrediction}, agreement=${(agreementRatio * 100).toFixed(0)}%, confidence=${(confidence * 100).toFixed(0)}%, prob=${(probability * 100).toFixed(1)}%`);

            return probability;

        } catch (error) {
            logger.error('Error in predictProbability:', error);
            // Fallback to hard prediction with moderate confidence
            const prediction = this.predict(features);
            return prediction === 1 ? 0.6 : 0.4;
        }
    }

    /**
     * Save the trained model to disk
     */
    save(): void {
        if (!this.model) return;
        const state = this.model.toJSON();
        fs.writeFileSync(this.modelPath, JSON.stringify(state));
        logger.info(`🧠 Model saved to ${this.modelPath}`);
    }

    /**
     * Load the model from disk
     */
    load(): boolean {
        if (fs.existsSync(this.modelPath)) {
            try {
                const data = fs.readFileSync(this.modelPath, 'utf8');
                const state = JSON.parse(data);
                this.model = RFClassifier.load(state);
                logger.info('🧠 Model loaded successfully.');
                return true;
            } catch (error) {
                logger.error('🧠 Failed to load model:', error);
                return false;
            }
        }
        return false;
    }
}

export const aiModel = new RandomForestModel();
