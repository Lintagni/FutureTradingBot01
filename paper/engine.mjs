// Claude Paper Trader — engine
// Runs on GitHub Actions every ~15 min (and right after Claude pushes decisions).
//   reads : config.json, data/ledger.json, data/decisions.json (written by Claude)
//   writes: data/ledger.json (engine's books), data/state.json (what Claude + dashboard read)
// PAPER ONLY — no exchange keys, no real orders. Prices: Kraken public API.

import fs from 'node:fs';

const CFG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const DATA = process.env.DATA_DIR || 'data';
const LEDGER = `${DATA}/ledger.json`;
const STATE = `${DATA}/state.json`;
const DECISIONS = `${DATA}/decisions.json`;
const NOW = process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : Date.now();   // FAKE_NOW: tests only
const iso = (t = NOW) => new Date(t).toISOString();
const r = (n, p = 6) => (Number.isFinite(n) ? +Number(n).toPrecision(p) : null);
const log = (...a) => console.log(`[${iso().slice(11, 19)}]`, ...a);

// ─── Market data (Kraken public OHLC; row = [time, o, h, l, c, vwap, vol, count]) ───
async function kraken(pair, interval) {
  if (process.env.MOCK_DIR) {   // offline tests
    return JSON.parse(fs.readFileSync(`${process.env.MOCK_DIR}/${pair}_${interval}.json`, 'utf8'));
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`, { signal: AbortSignal.timeout(20000) });
      const j = await res.json();
      if (j.error?.length) throw new Error(j.error.join(','));
      const key = Object.keys(j.result).find(k => k !== 'last');
      return j.result[key].map(c => ({ t: c[0] * 1000, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[6] }));
    } catch (e) {
      log(`Kraken ${pair} ${interval}m attempt ${attempt} failed: ${e.message}`);
      if (attempt === 3) throw e;
      await new Promise(res => setTimeout(res, 2000 * attempt));
    }
  }
}

// ─── Indicators ───
function ema(vals, p) { const k = 2 / (p + 1); let e = vals[0]; const out = [e]; for (let i = 1; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); } return out; }
function rsi(cl, p = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; d > 0 ? g += d : l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atrAdx(cs, p = 14) {
  const tr = [], pdm = [], ndm = [];
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i], pr = cs[i - 1];
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - pr.c), Math.abs(c.l - pr.c)));
    const up = c.h - pr.h, dn = pr.l - c.l;
    pdm.push(up > dn && up > 0 ? up : 0); ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr = tr.slice(0, p).reduce((a, b) => a + b, 0), sp = pdm.slice(0, p).reduce((a, b) => a + b, 0), sn = ndm.slice(0, p).reduce((a, b) => a + b, 0);
  const dx = [];
  for (let i = p; i < tr.length; i++) {
    atr = atr - atr / p + tr[i]; sp = sp - sp / p + pdm[i]; sn = sn - sn / p + ndm[i];
    const pdi = 100 * sp / atr, ndi = 100 * sn / atr;
    dx.push(pdi + ndi === 0 ? 0 : 100 * Math.abs(pdi - ndi) / (pdi + ndi));
  }
  let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  return { atr: atr / p, adx };
}
function indicators(cs) {
  if (cs.length < 60) return null;
  const cl = cs.map(c => c.c);
  const e9 = ema(cl, 9), e21 = ema(cl, 21), e50 = ema(cl, 50), e12 = ema(cl, 12), e26 = ema(cl, 26);
  const macd = e12.map((v, i) => v - e26[i]); const sig = ema(macd, 9);
  const { atr, adx } = atrAdx(cs);
  const n = cl.length - 1;
  return { rsi14: r(rsi(cl)), ema9: r(e9[n]), ema21: r(e21[n]), ema50: r(e50[n]), macdHist: r(macd[n] - sig[n]), atr14: r(atr), adx14: r(adx) };
}
const row = c => [iso(c.t).slice(0, 16), r(c.o), r(c.h), r(c.l), r(c.c), r(c.v, 5)];

// ─── Ledger ───
function loadJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
const ledger = loadJSON(LEDGER, null) || {
  createdAt: iso(), startEquity: CFG.startEquity, realizedPnl: 0, fees: 0,
  positions: {}, trades: [], decisionLog: [], consumed: [], equityHistory: [{ t: iso(), equity: CFG.startEquity }], lastRun: null,
};
const events = [];   // human-readable lines for Telegram + logs
const fee = notional => notional * CFG.feePctPerSide / 100;

function closePosition(sym, price, at, reason) {
  const p = ledger.positions[sym];
  const dir = p.side === 'long' ? 1 : -1;
  const exitFee = fee(price * p.qty);
  const gross = (price - p.entry) * p.qty * dir;
  const pnl = gross - p.entryFee - exitFee;
  ledger.realizedPnl += gross - exitFee;          // entry fee was already booked at open
  ledger.fees += exitFee;
  ledger.trades.push({
    symbol: sym, side: p.side, entry: p.entry, exit: r(price), qty: p.qty, notional: r(p.notional, 6), margin: r(p.margin, 6),
    leverage: p.leverage, pnl: r(pnl, 6), pnlPctOnMargin: r(pnl / p.margin * 100, 4), openedAt: p.openedAt, closedAt: iso(at),
    exitReason: reason, entryReason: p.reason, confidence: p.confidence, decisionId: p.decisionId,
  });
  delete ledger.positions[sym];
  events.push(`${pnl >= 0 ? '💰' : '📉'} CLOSED ${p.side.toUpperCase()} ${sym} @ ${r(price)} | P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${reason}`);
}

function openPosition(sym, side, price, d) {
  const equity = ledger.startEquity + ledger.realizedPnl;
  const margin = equity * CFG.marginPct;
  const notional = margin * CFG.leverage;
  const qty = notional / price;
  const entryFee = fee(notional);
  ledger.realizedPnl -= entryFee; ledger.fees += entryFee;
  const sl = side === 'long' ? price * (1 - CFG.stopLossPct / 100) : price * (1 + CFG.stopLossPct / 100);
  const tp = side === 'long' ? price * (1 + CFG.takeProfitPct / 100) : price * (1 - CFG.takeProfitPct / 100);
  ledger.positions[sym] = {
    side, entry: r(price), qty, notional, margin, leverage: CFG.leverage, entryFee,
    stopLoss: r(sl), takeProfit: r(tp), openedAt: iso(), reason: d.reason, confidence: d.confidence, decisionId: d.id,
  };
  events.push(`🟢 OPENED ${side.toUpperCase()} ${sym} @ ${r(price)} | $${notional.toFixed(2)} (${CFG.leverage}x, margin $${margin.toFixed(2)}) | SL ${r(sl)} TP ${r(tp)} | ${d.reason}`);
}

// ─── Main ───
const market = {};
for (const [sym, pair] of Object.entries(CFG.symbols)) {
  try {
    const [c5, c60, c240] = [await kraken(pair, 5), await kraken(pair, 60), await kraken(pair, 240)];
    market[sym] = { c5, c60, c240, price: c5[c5.length - 1].c };
  } catch (e) { log(`⚠️ ${sym}: no market data (${e.message}) — skipped this run`); }
}
if (!Object.keys(market).length) { log('❌ No market data at all — aborting without changes'); process.exit(1); }

// 1) Hard stop-loss / take-profit, checked on 5m candles since the last check
for (const [sym, p] of Object.entries({ ...ledger.positions })) {
  const m = market[sym]; if (!m) continue;
  const opened = Date.parse(p.openedAt);
  const from = Math.max(opened, Date.parse(p.lastCheckedCandle || 0));
  for (const c of m.c5) {
    if (c.t + 5 * 60e3 <= from) continue;       // fully before window
    if (c.t < opened) continue;                  // candle that contains the entry: skip (pre-entry wicks)
    const slHit = p.side === 'long' ? c.l <= p.stopLoss : c.h >= p.stopLoss;
    const tpHit = p.side === 'long' ? c.h >= p.takeProfit : c.l <= p.takeProfit;
    if (slHit) { closePosition(sym, p.stopLoss, c.t, `Stop-loss ${CFG.stopLossPct}%`); break; }   // SL first if both
    if (tpHit) { closePosition(sym, p.takeProfit, c.t, `Take-profit ${CFG.takeProfitPct}%`); break; }
  }
  if (ledger.positions[sym]) ledger.positions[sym].lastCheckedCandle = iso(m.c5[m.c5.length - 1].t);
}

// 2) Claude's decisions
const dec = loadJSON(DECISIONS, null);
const fresh = dec && Date.parse(dec.generatedAt) && (NOW - Date.parse(dec.generatedAt)) / 60e3 <= CFG.decisionMaxAgeMin && (NOW - Date.parse(dec.generatedAt)) > -10 * 60e3;
if (dec && !fresh) log(`Decisions from ${dec.generatedAt} are stale — ignoring (HOLD)`);
if (fresh) {
  const consumed = new Set(ledger.consumed);
  const entries = [];
  for (const [sym, d] of Object.entries(dec.decisions || {})) {
    if (!CFG.symbols[sym] || !d || typeof d.id !== 'string' || consumed.has(d.id)) continue;
    if (!['long', 'short', 'close', 'hold'].includes(d.action)) { log(`Bad action for ${sym}`); continue; }
    const pos = ledger.positions[sym];
    const posState = pos ? pos.side : 'flat';
    let applied = 'hold', note = '';
    if (d.posState !== posState) { note = `position changed since decision (${d.posState}→${posState})`; }
    else if (d.action === 'close' && pos) {
      if (market[sym]) { closePosition(sym, market[sym].price, NOW, `Claude: ${d.reason}`); applied = 'close'; } else note = 'no price';
    } else if ((d.action === 'long' || d.action === 'short') && pos && pos.side !== d.action) {
      if (market[sym]) { closePosition(sym, market[sym].price, NOW, `Claude flipped: ${d.reason}`); applied = 'close'; } else note = 'no price';
    } else if ((d.action === 'long' || d.action === 'short') && !pos) {
      entries.push([sym, d]); continue;          // decided below (max positions, confidence order)
    }
    consumed.add(d.id);
    ledger.decisionLog.push({ seenAt: iso(), symbol: sym, action: d.action, applied, confidence: d.confidence, reason: d.reason, note, id: d.id });
  }
  entries.sort((a, b) => (b[1].confidence || 0) - (a[1].confidence || 0));
  for (const [sym, d] of entries) {
    let applied = 'hold', note = '';
    if (Object.keys(ledger.positions).length >= CFG.maxOpenPositions) note = 'max open positions reached';
    else if (!market[sym]) note = 'no price';
    else { openPosition(sym, d.action, market[sym].price, d); applied = d.action; }
    consumed.add(d.id);
    ledger.decisionLog.push({ seenAt: iso(), symbol: sym, action: d.action, applied, confidence: d.confidence, reason: d.reason, note, id: d.id });
  }
  ledger.consumed = Array.from(consumed).slice(-300);
  ledger.decisionLog = ledger.decisionLog.slice(-300);
}

// 3) Mark to market
let unrealized = 0;
for (const [sym, p] of Object.entries(ledger.positions)) {
  const price = market[sym]?.price; if (!price) continue;
  const dir = p.side === 'long' ? 1 : -1;
  p.lastPrice = r(price);
  p.unrealizedPnl = r((price - p.entry) * p.qty * dir, 6);
  p.unrealizedPct = r((price - p.entry) / p.entry * 100 * dir, 4);
  unrealized += p.unrealizedPnl;
}
const equity = ledger.startEquity + ledger.realizedPnl;
const total = equity + unrealized;
const lastHist = ledger.equityHistory[ledger.equityHistory.length - 1];
if (events.length || !lastHist || NOW - Date.parse(lastHist.t) >= 55 * 60e3) ledger.equityHistory.push({ t: iso(), equity: r(total, 8) });
ledger.equityHistory = ledger.equityHistory.slice(-6000);
ledger.lastRun = iso();

// 4) State for Claude + dashboard
const closed = ledger.trades;
const wins = closed.filter(t => t.pnl > 0).length;
const state = {
  updatedAt: iso(), mode: 'paper', engine: 'github-actions', priceSource: 'Kraken spot',
  candleColumns: ['time_utc', 'open', 'high', 'low', 'close', 'volume'],
  rules: {
    maxOpenPositions: CFG.maxOpenPositions, leverage: CFG.leverage, marginPctOfEquity: CFG.marginPct * 100,
    hardStopLossPct: CFG.stopLossPct, hardTakeProfitPct: CFG.takeProfitPct, feePctPerSide: CFG.feePctPerSide,
    decisionMaxAgeMin: CFG.decisionMaxAgeMin,
  },
  goal: CFG.goal,
  account: {
    startingEquity: ledger.startEquity, realizedPnl: r(ledger.realizedPnl, 6), unrealizedPnl: r(unrealized, 6),
    equity: r(total, 8), fees: r(ledger.fees, 4), closedTrades: closed.length, wins, losses: closed.length - wins,
    since: ledger.createdAt,
  },
  openPositions: Object.entries(ledger.positions).map(([symbol, p]) => ({ symbol, ...p, qty: r(p.qty), notional: r(p.notional), margin: r(p.margin), entryFee: undefined })),
  recentClosedTrades: closed.slice(-10).reverse(),
  lastDecisions: ledger.decisionLog.slice(-6).reverse(),
  symbols: Object.fromEntries(Object.entries(market).map(([sym, m]) => [sym, {
    price: r(m.price),
    position: ledger.positions[sym] ? { side: ledger.positions[sym].side, entry: ledger.positions[sym].entry, unrealizedPct: ledger.positions[sym].unrealizedPct, openedAt: ledger.positions[sym].openedAt, stopLoss: ledger.positions[sym].stopLoss, takeProfit: ledger.positions[sym].takeProfit } : null,
    indicators1h: indicators(m.c60), indicators4h: indicators(m.c240),
    candles1h: m.c60.slice(-48).map(row), candles4h: m.c240.slice(-30).map(row),
  }])),
};

fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
for (const e of events) log(e);
log(`Equity $${total.toFixed(2)} (realized ${ledger.realizedPnl.toFixed(2)}, unrealized ${unrealized.toFixed(2)}) | open: ${Object.keys(ledger.positions).join(', ') || 'none'}`);

// 5) Optional Telegram (repo secrets TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)
const { TELEGRAM_BOT_TOKEN: tg, TELEGRAM_CHAT_ID: chat } = process.env;
if (tg && chat && events.length) {
  try {
    await fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `🤖 Claude Paper Trader\n${events.join('\n')}\nEquity: $${total.toFixed(2)}` }),
    });
  } catch (e) { log(`Telegram failed: ${e.message}`); }
}
