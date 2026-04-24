import { tradeRepository } from '../database/TradeRepository';
import { logger } from '../utils/logger';

export interface OwnTradeSamples {
    features: number[][];
    labels: number[];
}

/**
 * Extract AI training samples from the bot's own closed trade history.
 *
 * Each closed trade has its entryFeatures stored as a JSON array at open time.
 * The label is 1 (win) if realizedPnl > 0, else 0 (loss).
 * Returns a balanced dataset (equal wins and losses) to avoid class bias.
 */
export async function getOwnTradesSamples(limit: number = 500): Promise<OwnTradeSamples> {
    const trades = await tradeRepository.getClosedTradesWithFeatures(limit);

    const winFeatures: number[][] = [];
    const lossFeatures: number[][] = [];

    for (const trade of trades) {
        if (!trade.entryFeatures) continue;
        try {
            const feat = JSON.parse(trade.entryFeatures) as number[];
            if (!Array.isArray(feat) || feat.length !== 9) continue;
            if (!feat.every(v => Number.isFinite(v))) continue;

            const isWin = (trade.realizedPnl ?? 0) > 0;
            if (isWin) {
                winFeatures.push(feat);
            } else {
                lossFeatures.push(feat);
            }
        } catch (_) {
            // Corrupted feature JSON — skip
        }
    }

    if (winFeatures.length === 0 || lossFeatures.length === 0) {
        logger.info(`📚 TradeHistoryTrainer: insufficient own-trade data (wins=${winFeatures.length}, losses=${lossFeatures.length}) — skipping`);
        return { features: [], labels: [] };
    }

    // Balance: equal number of wins and losses
    const targetSize = Math.min(winFeatures.length, lossFeatures.length);
    const shuffledWins   = winFeatures.sort(() => Math.random() - 0.5).slice(0, targetSize);
    const shuffledLosses = lossFeatures.sort(() => Math.random() - 0.5).slice(0, targetSize);

    const features: number[][] = [];
    const labels: number[] = [];
    for (const f of shuffledWins)   { features.push(f); labels.push(1); }
    for (const f of shuffledLosses) { features.push(f); labels.push(0); }

    // Shuffle combined
    const idx = features.map((_, i) => i).sort(() => Math.random() - 0.5);
    const finalFeatures = idx.map(i => features[i]);
    const finalLabels   = idx.map(i => labels[i]);

    logger.info(`📚 TradeHistoryTrainer: ${finalFeatures.length} own-trade samples (${targetSize} wins + ${targetSize} losses)`);
    return { features: finalFeatures, labels: finalLabels };
}
