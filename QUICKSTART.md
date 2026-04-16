# 🚀 Quick Start Guide

## Your AI Trading Bot is Ready!

### ✅ What's Done
- ✅ All dependencies installed (295 packages)
- ✅ Database initialized (`trading.db`)
- ✅ Configuration file created (`.env`)
- ✅ Project structure complete
- ✅ Trading engine ready

---

## 🎯 Next Steps (5 minutes)

### 1. Get Binance Testnet API Keys

**For safe paper trading (NO REAL MONEY):**

1. Go to: https://testnet.binance.vision/
2. Click "Login with GitHub"
3. Click "Generate HMAC_SHA256 Key"
4. Copy the API Key and Secret Key

### 2. Add Keys to `.env`

Open `d:\webapp\new app\.env` and replace:

```env
BINANCE_API_KEY=your_binance_api_key_here
BINANCE_API_SECRET=your_binance_api_secret_here
```

With your actual testnet keys.

### 3. Run the Bot!

```bash
cd "d:\webapp\new app"
npm run paper-trade
```

---

## 📊 What Will Happen

The bot will:
1. ✅ Connect to Binance testnet
2. ✅ Monitor BTC/USDT and ETH/USDT
3. ✅ Analyze market every minute
4. ✅ Generate trading signals
5. ✅ Execute simulated trades
6. ✅ Log everything to `logs/combined.log`

---

## 🔍 Monitor Your Bot

### View Real-time Logs
```bash
Get-Content logs/combined.log -Wait
```

### View Database
```bash
npm run db:studio
```

Opens in browser to see:
- All trades
- Signals generated
- Market data
- Performance

---

## ⚙️ Current Settings

- **Mode**: Paper trading (safe!)
- **Pairs**: BTC/USDT, ETH/USDT
- **Timeframe**: 15-minute candles
- **Position Size**: **$1 - $50 per trade**
- **Stop Loss**: 2.5%
- **Take Profit**: 5.0%
- **Daily Loss Limit**: $200

---

## 🛑 Stop the Bot

Press `Ctrl+C` in the terminal

---

## 📚 Full Documentation

- **README.md** - Complete setup guide
- **walkthrough.md** - Detailed implementation walkthrough
- **implementation_plan.md** - Technical architecture

---

## ⚠️ Safety Reminders

1. ✅ Currently in **PAPER TRADING** mode (no real money)
2. ✅ Test for 24-48 hours before considering live trading
3. ✅ Never invest more than you can afford to lose
4. ✅ Read README.md for full safety guidelines

---

## 🎓 Strategy Overview

**Entry**: EMA crossover + MACD + RSI + Volume confirmation
**Exit**: Reverse crossover OR stop-loss/take-profit hit
**Risk**: 2% per trade, max 3 positions, daily loss limit

---

## 🆘 Troubleshooting

**"API key not valid"**
- Make sure you're using TESTNET keys from testnet.binance.vision
- Check keys are correctly pasted in `.env`

**No trades executing**
- This is normal! Bot waits for high-confidence signals
- Check logs to see signal analysis
- May take hours to find good entry

**Bot crashes**
- Check `logs/error.log`
- Make sure API keys are valid
- Ensure internet connection is stable

---

## 🚀 Ready to Start!

```bash
npm run paper-trade
```

**Happy trading! 🎉**
