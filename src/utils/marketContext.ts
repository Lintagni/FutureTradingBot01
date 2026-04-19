import { logger } from './logger';

interface FearGreedData {
    value: number;
    label: string;
    fetchedAt: number;
}

let fngCache: FearGreedData | null = null;
const FNG_CACHE_TTL = 60 * 60 * 1000; // 1 hour — index updates once daily

/**
 * Fetch the Crypto Fear & Greed Index from alternative.me (cached hourly).
 * Scale: 0–24 Extreme Fear | 25–49 Fear | 50–74 Greed | 75–100 Extreme Greed
 * Returns null on failure (network / API down) — callers must handle null gracefully.
 */
export async function getFearAndGreed(): Promise<{ value: number; label: string } | null> {
    if (fngCache && Date.now() - fngCache.fetchedAt < FNG_CACHE_TTL) {
        return { value: fngCache.value, label: fngCache.label };
    }
    try {
        const resp = await fetch('https://api.alternative.me/fng/?limit=1');
        const json: any = await resp.json();
        const item = json?.data?.[0];
        if (!item) return fngCache ? { value: fngCache.value, label: fngCache.label } : null;

        fngCache = {
            value: parseInt(item.value, 10),
            label: item.value_classification,
            fetchedAt: Date.now(),
        };
        logger.info(`😱 Fear & Greed Index: ${fngCache.value} — ${fngCache.label}`);
        return { value: fngCache.value, label: fngCache.label };
    } catch {
        // Return stale cache rather than nothing if available
        return fngCache ? { value: fngCache.value, label: fngCache.label } : null;
    }
}
