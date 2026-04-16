# AI Crypto Trading Bot

An AI-powered cryptocurrency trading bot for Binance and Bybit exchanges with automated trading strategies, risk management, and real-time monitoring.

## ⚠️ Important Disclaimers

**TRADING RISK**: Cryptocurrency trading involves substantial risk of loss. This bot executes real trades with real money. Never invest more than you can afford to lose.

**NO GUARANTEES**: Past performance does not guarantee future results. This bot is provided as-is with no guarantees of profitability.

**USE AT YOUR OWN RISK**: The authors are not responsible for any financial losses incurred while using this software.

## Features

- ✅ **Multi-Exchange Support**: Binance (Bybit coming soon)
- ✅ **Paper Trading Mode**: Test strategies without risking real money
- ✅ **Trend Following Strategy**: EMA crossovers, MACD, RSI, Bollinger Bands
- ✅ **Risk Management**: Position sizing, stop-loss, take-profit, daily loss limits
- ✅ **Real-time Monitoring**: Live market data and position tracking
- ✅ **Notifications**: Telegram and Discord alerts
- ✅ **Database Tracking**: Complete trade history and analytics
- ✅ **Backtesting**: Test strategies on historical data

## Quick Start

### 1. Prerequisites

- Node.js 18+ installed
- Binance account (or Bybit)
- API keys from your exchange

### 2. Installation

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run db:generate

# Initialize database
npm run db:push
```

### 3. Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# IMPORTANT: Start with paper trading!
TRADING_MODE=paper

# Add your Binance API keys
BINANCE_API_KEY=your_api_key_here
BINANCE_API_SECRET=your_api_secret_here

# Configure trading pairs
TRADING_PAIRS=BTC/USDT,ETH/USDT

# Set risk parameters
MAX_POSITION_SIZE=50
MIN_POSITION_SIZE=1
MAX_DAILY_LOSS=200
STOP_LOSS_PERCENTAGE=2.5
TAKE_PROFIT_PERCENTAGE=5.0
```

### 4. Get Binance API Keys

#### For Paper Trading (Testnet):
1. Go to [Binance Testnet](https://testnet.binance.vision/)
2. Login with GitHub
3. Generate API keys
4. Add to `.env` file

#### For Live Trading:
1. Login to [Binance](https://www.binance.com)
2. Go to API Management
3. Create new API key
4. **IMPORTANT**: 
   - Enable "Spot Trading" only
   - **DISABLE** "Enable Withdrawals"
   - Add IP whitelist for security
5. Add to `.env` file

### 5. Run the Bot

#### Paper Trading (Recommended First):
```bash
npm run paper-trade
```

#### Live Trading (After testing):
```bash
# Change TRADING_MODE=live in .env first!
npm start
```

## Project Structure

```
src/
├── config/           # Configuration files
├── core/            # Trading engine
├── exchanges/       # Exchange connectors
├── strategies/      # Trading strategies
├── risk/           # Risk management
├── database/       # Database operations
├── utils/          # Utilities (logger, notifier, indicators)
└── index.ts        # Main entry point
```

## Configuration Guide

### Trading Parameters

Edit `src/config/trading.config.ts` or use environment variables:

- **TRADING_PAIRS**: Cryptocurrencies to trade (e.g., `BTC/USDT,ETH/USDT`)
- **TIMEFRAME**: Candle timeframe (`1m`, `5m`, `15m`, `1h`, `4h`, `1d`)
- **MAX_POSITION_SIZE**: Maximum $ per trade
- **MAX_DAILY_LOSS**: Stop trading if daily loss exceeds this
- **STOP_LOSS_PERCENTAGE**: Auto-exit if price drops by this %
- **TAKE_PROFIT_PERCENTAGE**: Auto-exit if price rises by this %

### Strategy Parameters

- **EMA_SHORT**: Fast EMA period (default: 9)
- **EMA_LONG**: Slow EMA period (default: 21)
- **RSI_PERIOD**: RSI calculation period (default: 14)
- **RSI_OVERSOLD**: RSI oversold threshold (default: 30)
- **RSI_OVERBOUGHT**: RSI overbought threshold (default: 70)

### Notifications

#### Telegram:
1. Create a bot with [@BotFather](https://t.me/botfather)
2. Get your chat ID from [@userinfobot](https://t.me/userinfobot)
3. Add to `.env`:
```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

#### Discord:
1. Create a webhook in your Discord server
2. Add to `.env`:
```env
DISCORD_WEBHOOK_URL=your_webhook_url
```

## Safety Features

- **Paper Trading Mode**: Test without real money
- **Daily Loss Limits**: Automatically stops trading
- **Position Limits**: Maximum concurrent positions
- **Stop Loss**: Automatic exit on losses
- **Take Profit**: Automatic exit on gains
- **API Key Security**: Withdrawal permissions not required

## Monitoring

### View Database
```bash
npm run db:studio
```

### Check Logs
Logs are saved in `logs/` directory:
- `combined.log`: All logs
- `error.log`: Errors only

### Bot Status
The bot logs:
- Trade entries and exits
- P&L for each trade
- Risk metrics
- Strategy signals
- Errors and warnings

## Backtesting

Test your strategy on historical data:

```bash
npm run backtest
```

Edit `src/backtesting/backtest.ts` to configure:
- Date range
- Initial capital
- Strategy parameters

## Development

### Run in Development Mode
```bash
npm run dev
```

### Build for Production
```bash
npm run build
npm start
```

## Troubleshooting

### "API key not valid"
- Check your API keys in `.env`
- For testnet, use testnet keys
- For live, ensure keys have "Spot Trading" enabled

### "Insufficient balance"
- Check your exchange balance
- Reduce `MAX_POSITION_SIZE`
- For testnet, get test funds from Binance Testnet

### "Daily loss limit reached"
- Bot automatically stops when `MAX_DAILY_LOSS` is hit
- Wait until next day or adjust limit
- Review your strategy parameters

### No trades being executed
- Check if signals are being generated (view logs)
- Reduce `mlConfidenceThreshold` in config
- Verify market conditions are suitable for trend following

## Strategy Explanation

The bot uses a **Trend Following** strategy:

1. **EMA Crossover**: Detects trend changes when fast EMA crosses slow EMA
2. **MACD Confirmation**: Confirms trend with MACD histogram
3. **RSI Filter**: Avoids overbought/oversold conditions
4. **Volume Confirmation**: Requires above-average volume
5. **Bollinger Bands**: Identifies potential reversals

**Entry**: Bullish crossover + confirmations
**Exit**: Bearish crossover OR stop-loss/take-profit hit

## Roadmap

- [ ] AI/ML signal enhancement with Random Forest
- [ ] Bybit exchange integration
- [ ] Web dashboard for monitoring
- [ ] More strategies (mean reversion, arbitrage)
- [ ] Advanced backtesting with metrics
- [ ] Portfolio rebalancing
- [ ] Multi-timeframe analysis

## Support

For issues or questions:
1. Check the logs in `logs/` directory
2. Review configuration in `.env`
3. Test with paper trading first

## License

MIT License - Use at your own risk

---

**Remember**: Always start with paper trading, use small amounts initially, and never invest more than you can afford to lose.
