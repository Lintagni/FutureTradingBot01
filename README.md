# Claude Paper Trader

> The previous Bybit/Fly.io bot was removed from this branch (it's still in git history). This repo now runs the free GitHub Actions paper trader.

Claude decides **long / short / close / hold** for BTC, ETH and SOL. Code enforces the risk caps. Paper money only, starting from $100. Inspired by the "trading $100 with Claude" videos.

It runs **24/7 for free**. You don't need a server, an API key or your PC.

```
GitHub Actions (every 15 min)          Claude (scheduled task, every 4 h)
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ engine.mjs                   │       │ reads paper/data/state.json  │
│  • Kraken 5m/1h/4h candles   │──────▶│ decides per coin + 1-line    │
│  • hard SL/TP on 5m candles  │ state │   reason                     │
│  • applies Claude decisions  │◀──────│ pushes decisions.json        │
│  • writes ledger + state     │ dec.  └──────────────────────────────┘
└──────────────────────────────┘
            │
            ▼
   docs/index.html on GitHub Pages: equity curve, P&L, trades, reasons
```

## Rules (paper/config.json)

| Setting | Value |
|---|---|
| Coins | BTC/USDT, ETH/USDT, SOL/USDT (Kraken spot prices) |
| Start | $100 paper equity |
| Positions | max 1 open at a time |
| Size | 20% of current equity as margin, 2x leverage (isolated) |
| Hard stop / target | −3% / +9% price move, checked on 5-minute candles |
| Fees | 0.06% per side (taker) |
| Decisions expire | after 300 min, then the engine holds |

Safety:
- A decision only applies if the position state Claude saw still matches (`posState`).
- Each decision `id` is used once, so a "long" is never re-used after that trade is stopped out.
- If market data fails, that coin is skipped for the run.

## Files

- `paper/engine.mjs`: the paper-trading engine (Node 20, no dependencies)
- `paper/config.json`: the rules above
- `paper/data/decisions.json`: written by Claude only
- `paper/data/ledger.json`: the engine's books (positions, trades, equity history, decision log)
- `paper/data/state.json`: market snapshot, account and positions, for Claude and the dashboard
- `docs/index.html`: the dashboard (GitHub Pages: master / docs)
- `.github/workflows/paper-engine.yml`: runs every 15 minutes, and immediately when `decisions.json` changes

## Optional: Telegram alerts

Repo → Settings → Secrets and variables → Actions → add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

## decisions.json format

```json
{
  "generatedAt": "2026-10-15T20:07:00Z",
  "decisions": {
    "BTC/USDT": { "id": "2026-10-15T20:07:00Z-BTC", "action": "hold", "confidence": 0.6, "posState": "flat", "reason": "one line" }
  }
}
```

Not financial advice. Paper trading only.
