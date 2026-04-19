import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/trading.config';
import { logger } from './logger';
import { version as BOT_VERSION } from '../../package.json';

class Notifier {
    private telegramBot?: TelegramBot;
    private chatId?: string;

    constructor() {
        logger.info(`🔌 Notifier initializing. Telegram Enabled: ${config.notifications.telegram.enabled}`);
        if (config.notifications.telegram.enabled) {
            this.telegramBot = new TelegramBot(config.notifications.telegram.botToken, {
                polling: {
                    interval: 2000,
                    autoStart: true,
                    params: {
                        timeout: 10,
                        allowed_updates: ['message', 'callback_query'],
                    }
                }
            });
            this.chatId = config.notifications.telegram.chatId;

            // Handle polling errors gracefully
            this.telegramBot.on('polling_error', (error: any) => {
                if (error.code === 'ETELEGRAM' && error.message?.includes('409')) {
                    // Another instance is still running — stop polling and retry after 5s
                    logger.warn('⚠️ Telegram 409 conflict (old instance still shutting down) — retrying in 5s...');
                    this.telegramBot!.stopPolling().then(() => {
                        setTimeout(() => {
                            this.telegramBot!.startPolling();
                        }, 5000);
                    }).catch(() => {});
                } else if (error.code === 'EFATAL' || error.message?.includes('ECONNRESET')) {
                    logger.warn('⚠️ Telegram polling connection reset. Will auto-retry...');
                } else if (error.code === 'ETIMEDOUT') {
                    logger.warn('⚠️ Telegram polling timeout. Will auto-retry...');
                } else {
                    logger.warn('⚠️ Telegram polling error:', error.message || error);
                }
            });

            this.telegramBot.on('message', (msg) => {
                logger.info(`📩 Telegram Msg: "${msg.text}" | From: ${msg.chat.id} | Expected: ${this.chatId}`);
            });
        }
    }

    // ─── Inline keyboard shown on the control panel message ───
    private getControlPanelKeyboard(isRunning: boolean) {
        return {
            inline_keyboard: [
                [
                    { text: isRunning ? '⏹ Stop Bot' : '▶️ Start Bot', callback_data: isRunning ? 'stop_bot' : 'start_bot' },
                    { text: '📊 Status', callback_data: 'status' },
                ],
                [
                    { text: '🎯 Pairs', callback_data: 'pairs' },
                    { text: '🤖 Retrain AI', callback_data: 'retrain' },
                ],
                [
                    { text: '📋 Readiness', callback_data: 'readiness' },
                    { text: '⚙️ Min Size', callback_data: 'min_size' },
                ],
                [
                    { text: '🔍 Scanner', callback_data: 'scanner' },
                    { text: '🔄 Rescan', callback_data: 'rescan' },
                ],
                [
                    { text: '🌐 Live Dashboard', url: 'https://futures-trading-bot-wmg.fly.dev/' },
                ],
            ],
        };
    }

    // ─── Persistent reply keyboard (always visible at bottom of chat) ───
    private getPersistentKeyboard() {
        return {
            keyboard: [
                [{ text: '📊 Status' }, { text: '▶️ Start Bot' }, { text: '⏹ Stop Bot' }],
                [{ text: '🎯 Pairs' }, { text: '📋 Readiness' }, { text: '🤖 Retrain AI' }],
                [{ text: '🔍 Scanner' }, { text: '🔄 Rescan' }, { text: '⚙️ Min Size' }],
            ],
            resize_keyboard: true,
            persistent: true,
            is_persistent: true,
        };
    }

    registerBotCommands(callbacks: {
        onStart: () => Promise<void>;
        onStop: (reason?: string) => void;
        onStatus: () => Promise<any>;
        onAnalyze: (symbol: string) => Promise<any>;
        onAddPair: (symbol: string) => Promise<string>;
        onRemovePair: (symbol: string) => Promise<string>;
        onUpdateMinSize: (newSize: number) => Promise<string>;
        onGetMinSize: () => number;
        onScannerStatus?: () => Promise<any>;
        onForceRescan?: () => Promise<string>;
        onGetActivePairs?: () => string[];
        onForceRetrain?: () => Promise<string>;
        isRunning?: () => boolean;
    }): void {
        if (!this.telegramBot || !this.chatId) return;

        // ─── Helper: build readiness message ───
        const buildReadiness = async (): Promise<string> => {
            const s = await callbacks.onStatus();
            if (config.mode !== 'paper') {
                return '📋 *Live Readiness* — Bot is already in LIVE mode.';
            }
            if (!s.readiness) {
                return '📋 *Live Readiness* — data not available yet.';
            }
            const r = s.readiness;
            const t = r.thresholds;
            const scoreBar = r.score >= 100 ? '✅ Ready to go live!' : `${r.score}% ready`;
            const modelFreshStr = t.modelFresh.value >= 9999 ? 'Never trained' : `${t.modelFresh.value}h ago`;
            return `
📋 *Live Readiness* — ${scoreBar}

${t.trades.pass ? '✅' : '❌'} Closed trades: ${t.trades.value}/${t.trades.target}
${t.winRate.pass ? '✅' : '❌'} Win rate: ${(t.winRate.value || 0).toFixed(1)}% (need ≥${t.winRate.target}%)
${t.profitable.pass ? '✅' : '❌'} Total P&L: ${t.profitable.value >= 0 ? '+' : ''}$${(t.profitable.value || 0).toFixed(2)}
${t.modelTrained.pass ? '✅' : '❌'} AI model trained: ${t.modelTrained.pass ? 'Yes' : 'Not yet'}
${t.modelFresh.pass ? '✅' : '❌'} Model freshness: ${modelFreshStr}
${t.dailyHealth.pass ? '✅' : '❌'} Today P&L healthy: ${t.dailyHealth.pass ? 'Yes' : 'No'}

_When 100%: set_ \`TRADING\\_MODE=live\` _\\+ real Bybit API keys_
            `.trim();
        };

        // ─── Helper: build and send status message ───
        const sendStatus = async () => {
            const s = await callbacks.onStatus();
            const pnlSign = s.dailyPnL >= 0 ? '+' : '';
            const totalPnlSign = s.totalPnL >= 0 ? '+' : '';
            const pnlEmoji = s.dailyPnL >= 0 ? '💰' : '📉';

            let positionsSection = '';
            if (s.positionDetails && s.positionDetails.length > 0) {
                for (const pos of s.positionDetails) {
                    const sideEmoji = pos.side === 'buy' ? '🟢 LONG' : '🔴 SHORT';
                    const curPrice = pos.currentPrice ? ` → $${pos.currentPrice.toFixed(4)}` : '';
                    const pnlStr = pos.pnlPct != null && pos.pnlPct !== 0
                        ? ` (${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(2)}%)`
                        : '';
                    positionsSection += `\n  ${sideEmoji} ${pos.symbol} @ $${pos.entryPrice.toFixed(4)}${curPrice}${pnlStr}`;
                }
            } else {
                positionsSection = '\n  (No open positions)';
            }

            let balanceLines = '';
            if (s.walletBalances) {
                // Handle both Map and plain object (paper mode serializes differently)
                const entries: [string, number][] = s.walletBalances instanceof Map
                    ? [...s.walletBalances.entries()]
                    : Object.entries(s.walletBalances) as [string, number][];
                for (const [coin, amount] of entries) {
                    if ((amount as number) > 0.0001 || coin === 'USDT') {
                        balanceLines += `\n  ${coin}: ${(amount as number).toFixed(4)}`;
                    }
                }
            }

            const pairsList = s.monitoredPairs.map((p: string) => `  • ${p}`).join('\n');
            const autoMode = config.autoPairSelection ? '🤖 Auto' : '📌 Manual';

            // ─── Live Readiness block (paper mode only) ───
            let readinessBlock = '';
            if (config.mode === 'paper' && s.readiness) {
                const r = s.readiness;
                const t = r.thresholds;
                const scoreBar = r.score >= 100 ? '✅ Ready!' : `${r.score}% Ready`;
                const modelFreshStr = t.modelFresh.value >= 9999 ? 'Never' : `${t.modelFresh.value}h ago`;
                readinessBlock = `

🎯 *Live Readiness* — ${scoreBar}
${t.trades.pass ? '✅' : '❌'} Closed trades: ${t.trades.value}/${t.trades.target}
${t.winRate.pass ? '✅' : '❌'} Win rate: ${(t.winRate.value || 0).toFixed(1)}% (need ≥${t.winRate.target}%)
${t.profitable.pass ? '✅' : '❌'} Total P&L: ${t.profitable.value >= 0 ? '+' : ''}$${(t.profitable.value || 0).toFixed(2)}
${t.modelTrained.pass ? '✅' : '❌'} AI model trained: ${t.modelTrained.pass ? 'Yes' : 'Not yet'}
${t.modelFresh.pass ? '✅' : '❌'} Model freshness: ${modelFreshStr} (need <${t.modelFresh.target}h)
${t.dailyHealth.pass ? '✅' : '❌'} Today's P&L healthy: ${t.dailyHealth.pass ? 'Yes' : 'No'}

_When 100%: set_ \`TRADING\\_MODE=live\` _\\+ real Bybit API keys_`;
            }

            return `
📊 *Bot Status* — v${BOT_VERSION}

*State:* ${s.isRunning ? '✅ Running' : '🛑 Stopped'}
*Mode:* ${config.mode.toUpperCase()} | ${autoMode} Pairs
*Futures:* ${config.futures.leverage}x ${config.futures.marginMode} margin

💹 *Performance*
Daily P&L: ${pnlEmoji} ${pnlSign}$${s.dailyPnL.toFixed(2)}
Total P&L: ${totalPnlSign}$${s.totalPnL.toFixed(2)}
Unrealized: ${s.unrealizedPnL != null ? ((s.unrealizedPnL >= 0 ? '+' : '') + '$' + Math.abs(s.unrealizedPnL).toFixed(2)) : '—'}
Win Rate: ${(s.recentWinRate ?? 0).toFixed(1)}% (Recent) | ${(s.lifetimeWinRate ?? 0).toFixed(1)}% (Lifetime)

📈 *Open Positions (${s.openPositions}):*${positionsSection}

🔍 *Monitoring (${s.monitoredPairs.length}):*
${pairsList || '  (none)'}

👛 *Wallet:*${balanceLines || '\n  (No balances)'}${readinessBlock}
            `.trim();
        };

        // ─── /start — Control panel with inline buttons + persistent keyboard ───
        this.telegramBot.onText(/\/start/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            const s = await callbacks.onStatus();
            await this.sendControlPanel(s.isRunning);
        });

        // ─── Persistent keyboard button texts ───
        this.telegramBot.onText(/^📊 Status$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            try {
                const message = await sendStatus();
                await this.sendTelegramMessage(message);
            } catch (e: any) {
                await this.sendTelegramMessage(`⚠️ Status error: ${e.message}`);
            }
        });
        this.telegramBot.onText(/^▶️ Start Bot$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            await this.sendTelegramMessage('🚀 Starting Trading Bot...');
            await callbacks.onStart();
            await this.sendControlPanel(true);
        });
        this.telegramBot.onText(/^⏹ Stop Bot$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            callbacks.onStop('User pressed Stop button');
            await this.sendTelegramMessage('🛑 Trading Bot stopped.');
            await this.sendControlPanel(false);
        });
        this.telegramBot.onText(/^🔍 Scanner$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            await this.sendTelegramMessage(await this.buildScannerMessage(callbacks));
        });
        this.telegramBot.onText(/^🔄 Rescan$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            if (!config.autoPairSelection || !callbacks.onForceRescan) {
                await this.sendTelegramMessage('📌 Auto Pair Selection is disabled.');
                return;
            }
            await this.sendTelegramMessage('🔄 Forcing market re-scan...');
            const result = await callbacks.onForceRescan();
            await this.sendTelegramMessage(result);
        });
        this.telegramBot.onText(/^🎯 Pairs$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            await this.sendTelegramMessage(this.buildPairsMessage(callbacks));
        });
        this.telegramBot.onText(/^🤖 Retrain AI$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            if (!callbacks.onForceRetrain) {
                await this.sendTelegramMessage('⚠️ Retrain not available.');
                return;
            }
            await this.sendTelegramMessage('🔄 Starting AI retrain... (~60 seconds)');
            const result = await callbacks.onForceRetrain();
            await this.sendTelegramMessage(result);
        });
        this.telegramBot.onText(/^📋 Readiness$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            try {
                await this.sendTelegramMessage(await buildReadiness());
            } catch (e: any) {
                await this.sendTelegramMessage(`⚠️ Readiness error: ${e.message}`);
            }
        });
        this.telegramBot.onText(/^⚙️ Min Size$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            const minSize = callbacks.onGetMinSize();
            await this.sendTelegramMessage(
                `⚙️ *Min Position Size*\n\nCurrent: *$${minSize.toFixed(2)}*\n\nTo change, send:\n/min\\_size <value>\n\nExample: /min\\_size 20`
            );
        });
        this.telegramBot.onText(/^❓ Help$/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            await this.sendTelegramMessage(`
🤖 *Futures Trading Bot — Commands*

🔧 *Control*
/start — Open control panel with buttons
/start\\_bot — Start trading engine
/stop\\_bot — Stop trading engine

📊 *Monitoring*
/status — Bot status & P&L
/readiness — Go\\-live readiness score
/pairs — Active trading pairs
/scanner — Pair scanner rankings
/analyze <pair> — Market analysis

🎯 *Pair Management*
/rescan — Force market re\\-scan
/add\\_pair <pair> — Add pair manually
/remove\\_pair <pair> — Remove pair

⚙️ *Settings*
/min\\_size <value> — Set min position $
/get\\_min\\_size — Show config
/retrain — Force AI retrain now
            `.trim());
        });

        // ─── /status ───
        this.telegramBot.onText(/\/status/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            try {
                const message = await sendStatus();
                await this.sendTelegramMessage(message);
            } catch (e: any) {
                await this.sendTelegramMessage(`⚠️ Status error: ${e.message}`);
            }
        });

        // ─── /scanner ───
        this.telegramBot.onText(/\/scanner/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            await this.sendTelegramMessage(await this.buildScannerMessage(callbacks));
        });

        // ─── /pairs ───
        this.telegramBot.onText(/\/pairs/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            await this.sendTelegramMessage(this.buildPairsMessage(callbacks));
        });

        // ─── /rescan ───
        this.telegramBot.onText(/\/rescan/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            if (!config.autoPairSelection || !callbacks.onForceRescan) {
                await this.sendTelegramMessage('📌 Auto Pair Selection is disabled.');
                return;
            }
            await this.sendTelegramMessage('🔄 Forcing market re-scan...');
            const result = await callbacks.onForceRescan();
            await this.sendTelegramMessage(result);
        });

        // ─── /analyze <pair> ───
        this.telegramBot.onText(/\/analyze (.+)/, async (msg, match) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            const symbol = match ? match[1].toUpperCase() : '';
            if (!symbol) {
                await this.sendTelegramMessage('⚠️ Example: /analyze BTC/USDT');
                return;
            }
            await this.sendTelegramMessage(`🔍 Analyzing ${symbol}...`);
            const analysis = await callbacks.onAnalyze(symbol);
            if (analysis.error) {
                await this.sendTelegramMessage(`⚠️ Error: ${analysis.error}`);
                return;
            }
            const message = `
🧐 *Market Analysis: ${analysis.symbol}*
Price: $${analysis.price.toFixed(2)}
Signal: ${analysis.signal.toUpperCase()} (${analysis.direction?.toUpperCase() || ''})
Confidence: ${(analysis.confidence * 100).toFixed(1)}%
Reason: ${analysis.reason}

*Indicators:*
RSI: ${analysis.indicators.rsi.toFixed(2)}
MACD: ${analysis.indicators.macd.MACD.toFixed(4)}
Trend: ${analysis.price > analysis.indicators.ema21 ? '📈 Bullish' : '📉 Bearish'}
            `.trim();
            await this.sendTelegramMessage(message);
        });

        // ─── /start_bot / /stop_bot (text commands) ───
        this.telegramBot.onText(/\/start_bot/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            await this.sendTelegramMessage('🚀 Starting Trading Bot...');
            await callbacks.onStart();
        });

        this.telegramBot.onText(/\/stop_bot/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            callbacks.onStop('User command');
            await this.sendTelegramMessage('🛑 Trading Bot stopped.');
        });

        // ─── Pair Management ───
        this.telegramBot.onText(/\/add_pair (.+)/, async (msg, match) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            const symbol = match ? match[1].toUpperCase() : '';
            if (!symbol) return this.sendTelegramMessage('⚠️ Example: /add_pair SOL/USDT');
            const result = await callbacks.onAddPair(symbol);
            await this.sendTelegramMessage(result);
        });

        this.telegramBot.onText(/\/remove_pair (.+)/, async (msg, match) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            const symbol = match ? match[1].toUpperCase() : '';
            if (!symbol) return this.sendTelegramMessage('⚠️ Example: /remove_pair SOL/USDT');
            const result = await callbacks.onRemovePair(symbol);
            await this.sendTelegramMessage(result);
        });

        // ─── Position Size ───
        this.telegramBot.onText(/\/min_size (\d+\.?\d*)/, async (msg, match) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            const size = match ? parseFloat(match[1]) : 0;
            if (size <= 0) return this.sendTelegramMessage('⚠️ Example: /min_size 15');
            const result = await callbacks.onUpdateMinSize(size);
            await this.sendTelegramMessage(result);
        });

        this.telegramBot.onText(/\/get_min_size/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            const minSize = callbacks.onGetMinSize();
            const message = `
⚙️ *Position Size Config*
Min Size: $${minSize.toFixed(2)}
SL: ${config.risk.stopLossPercentage}% | TP: ${config.risk.takeProfitPercentage}%
Leverage: ${config.futures.leverage}x ${config.futures.marginMode}
Trailing: +${config.strategy.trailingStopActivation}% activate, ${config.strategy.trailingStopDistance}% trail
            `.trim();
            await this.sendTelegramMessage(message);
        });

        // ─── /readiness ───
        this.telegramBot.onText(/\/readiness/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            try {
                await this.sendTelegramMessage(await buildReadiness());
            } catch (e: any) {
                await this.sendTelegramMessage(`⚠️ Readiness error: ${e.message}`);
            }
        });

        // ─── /retrain ───
        this.telegramBot.onText(/\/retrain/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            if (!callbacks.onForceRetrain) {
                await this.sendTelegramMessage('⚠️ Retrain not available.');
                return;
            }
            await this.sendTelegramMessage('🔄 Starting AI retrain... This may take ~60 seconds.');
            const result = await callbacks.onForceRetrain();
            await this.sendTelegramMessage(result);
        });

        // ─── /help ───
        this.telegramBot.onText(/\/help/, async (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            await this.sendTelegramMessage(`
🤖 *Futures Trading Bot — Commands*

🔧 *Control*
/start — Open control panel with buttons
/start\\_bot — Start trading engine
/stop\\_bot — Stop trading engine

📊 *Monitoring*
/status — Bot status & P&L
/readiness — Go\\-live readiness score
/pairs — Active trading pairs
/scanner — Pair scanner rankings
/analyze <pair> — Market analysis

🎯 *Pair Management*
/rescan — Force market re\\-scan
/add\\_pair <pair> — Add pair manually
/remove\\_pair <pair> — Remove pair

⚙️ *Settings*
/min\\_size <value> — Set min position $
/get\\_min\\_size — Show config
/retrain — Force AI retrain now
            `.trim());
        });

        // ─── Inline button callback handler ───
        this.telegramBot.on('callback_query', async (query) => {
            if (!query.message || query.message.chat.id.toString() !== this.chatId) return;

            const data = query.data;

            // Acknowledge the button press immediately (removes loading spinner)
            await this.telegramBot!.answerCallbackQuery(query.id, { text: '⏳ Processing...' });

            try {
                switch (data) {
                    case 'start_bot': {
                        await this.telegramBot!.editMessageText('🚀 Starting Trading Bot...', {
                            chat_id: this.chatId,
                            message_id: query.message.message_id,
                        });
                        await callbacks.onStart();
                        await this.sendControlPanel(true);
                        break;
                    }
                    case 'stop_bot': {
                        callbacks.onStop('User pressed Stop button');
                        await this.telegramBot!.editMessageText('🛑 Trading Bot stopped.', {
                            chat_id: this.chatId,
                            message_id: query.message.message_id,
                        });
                        await this.sendControlPanel(false);
                        break;
                    }
                    case 'status': {
                        const message = await sendStatus();
                        await this.sendTelegramMessage(message);
                        break;
                    }
                    case 'scanner': {
                        const msg = await this.buildScannerMessage(callbacks);
                        await this.sendTelegramMessage(msg);
                        break;
                    }
                    case 'rescan': {
                        if (!callbacks.onForceRescan) break;
                        await this.sendTelegramMessage('🔄 Forcing market re-scan...');
                        const result = await callbacks.onForceRescan();
                        await this.sendTelegramMessage(result);
                        break;
                    }
                    case 'pairs': {
                        await this.sendTelegramMessage(this.buildPairsMessage(callbacks));
                        break;
                    }
                    case 'retrain': {
                        if (!callbacks.onForceRetrain) break;
                        await this.sendTelegramMessage('🔄 Starting AI retrain... (~60 seconds)');
                        const result = await callbacks.onForceRetrain();
                        await this.sendTelegramMessage(result);
                        break;
                    }
                    case 'readiness': {
                        try {
                            await this.sendTelegramMessage(await buildReadiness());
                        } catch (e: any) {
                            await this.sendTelegramMessage(`⚠️ Readiness error: ${e.message}`);
                        }
                        break;
                    }
                    case 'min_size': {
                        const minSize = callbacks.onGetMinSize();
                        await this.sendTelegramMessage(
                            `⚙️ *Min Position Size*\n\nCurrent: *$${minSize.toFixed(2)}*\n\nTo change, send:\n/min\\_size <value>\n\nExample: /min\\_size 20`
                        );
                        break;
                    }
                }
            } catch (err) {
                logger.error('Callback query handler error:', err);
            }
        });

        logger.info('Telegram command handlers registered');
    }

    // ─── Send the control panel with inline buttons + persistent keyboard ───
    async sendControlPanel(isRunning: boolean): Promise<void> {
        if (!this.telegramBot || !this.chatId) return;

        const statusLine = isRunning ? '✅ Bot is *RUNNING*' : '🛑 Bot is *STOPPED*';
        const message = `
🎮 *Control Panel*
${statusLine}
Mode: ${config.mode.toUpperCase()} | Futures ${config.futures.leverage}x ${config.futures.marginMode}

Tap a button below to control the bot:
        `.trim();

        try {
            await this.telegramBot.sendMessage(this.chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    ...this.getControlPanelKeyboard(isRunning),
                } as any,
            });
            // Also send/refresh the persistent reply keyboard
            await this.telegramBot.sendMessage(this.chatId, '⌨️ Keyboard ready — buttons are always visible below.', {
                reply_markup: this.getPersistentKeyboard() as any,
            });
        } catch (error) {
            logger.error('Failed to send control panel:', error);
        }
    }

    // ─── Build scanner message ───
    private async buildScannerMessage(callbacks: any): Promise<string> {
        if (!config.autoPairSelection) {
            return '📌 Auto Pair Selection is *disabled*.\nSet `AUTO_PAIR_SELECTION=true` in .env to enable.';
        }
        if (!callbacks.onScannerStatus) return '⚠️ Scanner not available.';

        const scannerData = await callbacks.onScannerStatus();
        if (!scannerData || scannerData.pairs.length === 0) {
            return '🔍 No scanner data yet. Scanner runs every 5 min.';
        }

        let pairLines = '';
        for (let i = 0; i < scannerData.pairs.length; i++) {
            const p = scannerData.pairs[i];
            const rank = i < scannerData.activePairCount ? '🟢' : '⚪';
            pairLines += `\n${rank} *${p.symbol}*: ${p.score.toFixed(0)} pts`;
            pairLines += `\n   ADX: ${p.adx.toFixed(1)} | Vol: ${p.volumeRatio.toFixed(1)}x | ATR: ${p.atrPct.toFixed(2)}%`;
            pairLines += `\n   RSI: ${p.rsi.toFixed(1)} | EMA: ${p.emaAligned ? '✅' : '❌'} | $${(p.dailyVolumeUSD / 1e6).toFixed(1)}M vol\n`;
        }

        const minutesAgo = scannerData.minutesSinceLastScan >= 0
            ? `${scannerData.minutesSinceLastScan.toFixed(0)} min ago`
            : 'Never';

        return `
🔍 *Market Scanner*

*Last Scan:* ${minutesAgo}
*Active Pairs:* ${scannerData.activePairCount}
${pairLines}
🟢 = Selected | ⚪ = Runner-up
        `.trim();
    }

    // ─── Build pairs message ───
    private buildPairsMessage(callbacks: any): string {
        const activePairs = callbacks.onGetActivePairs ? callbacks.onGetActivePairs() : config.tradingPairs;
        if (activePairs.length === 0) {
            return '📌 No active trading pairs. Bot may not be running.';
        }
        let pairList = '';
        for (const pair of activePairs) {
            pairList += `\n• ${pair}  →  /analyze ${pair}`;
        }
        const mode = config.autoPairSelection ? '🤖 Auto-selected' : '📌 Manual';
        return `
🎯 *Active Trading Pairs* (${mode})
${pairList}

_Tap any /analyze command above for details._
        `.trim();
    }

    async sendTelegramMessage(message: string): Promise<void> {
        if (!this.telegramBot || !this.chatId) return;
        try {
            await this.telegramBot.sendMessage(this.chatId, message, {
                parse_mode: 'Markdown',
            });
        } catch (error) {
            logger.error('Failed to send Telegram message:', error);
        }
    }

    async sendDiscordMessage(message: string): Promise<void> {
        if (!config.notifications.discord.enabled) {
            return;
        }

        try {
            await fetch(config.notifications.discord.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: message }),
            });
        } catch (error) {
            logger.error('Failed to send Discord message:', error);
        }
    }

    async notifyTrade(data: {
        symbol: string;
        side: 'buy' | 'sell';
        price: number;
        amount: number;
        cost: number;
    }): Promise<void> {
        const emoji = data.side === 'buy' ? '🟢' : '🔴';
        const message = `
${emoji} *${data.side.toUpperCase()} ${data.symbol}*
Price: $${data.price.toFixed(2)}
Amount: ${data.amount.toFixed(6)}
Cost: $${data.cost.toFixed(2)}
    `.trim();

        await this.sendTelegramMessage(message);
        await this.sendDiscordMessage(message);
    }

    async notifyPositionClosed(data: {
        symbol: string;
        side: string;
        entryPrice: number;
        exitPrice: number;
        pnl: number;
        pnlPercentage: number;
    }): Promise<void> {
        const emoji = data.pnl > 0 ? '💰' : '📉';
        const sign = data.pnl > 0 ? '+' : '';
        const tradeType = data.side === 'buy' ? 'Long' : 'Short';

        const message = `
${emoji} *Position Closed (${tradeType}): ${data.symbol}*
Entry: $${data.entryPrice.toFixed(2)}
Exit: $${data.exitPrice.toFixed(2)}
P&L: ${sign}$${data.pnl.toFixed(2)} (${sign}${data.pnlPercentage.toFixed(2)}%)
    `.trim();

        await this.sendTelegramMessage(message);
        await this.sendDiscordMessage(message);
    }

    /**
     * Public convenience method to send a message to all channels
     */
    async sendMessage(message: string): Promise<void> {
        await this.sendTelegramMessage(message);
        await this.sendDiscordMessage(message);
    }

    async notifyError(error: string): Promise<void> {
        const message = `⚠️ *Error*\n${error}`;
        await this.sendTelegramMessage(message);
        await this.sendDiscordMessage(message);
    }

    async notifyDailySummary(data: {
        date: string;
        totalTrades: number;
        winRate: number;
        netPnl: number;
    }): Promise<void> {
        const emoji = data.netPnl > 0 ? '📈' : '📉';
        const sign = data.netPnl > 0 ? '+' : '';
        const message = `
${emoji} *Daily Summary - ${data.date}*
Trades: ${data.totalTrades}
Win Rate: ${data.winRate.toFixed(1)}%
Net P&L: ${sign}$${data.netPnl.toFixed(2)}
    `.trim();

        await this.sendTelegramMessage(message);
        await this.sendDiscordMessage(message);
    }

    async notifyBotStarted(): Promise<void> {
        const mode = config.autoPairSelection ? '🤖 Auto Pair Selection' : '📌 Manual Pairs';
        const pairs = config.tradingPairs.join(', ');
        const message = `🚀 *Futures Trading Bot Started* — v${BOT_VERSION}\nMode: ${config.mode.toUpperCase()} | ${config.futures.leverage}x ${config.futures.marginMode}\nPairs: ${mode}\nSeed: ${pairs}`;
        await this.sendTelegramMessage(message);
        await this.sendDiscordMessage(message);
        // Show control panel with inline buttons after startup notification
        await this.sendControlPanel(true);
    }

    async notifyBotStopped(reason?: string): Promise<void> {
        const message = `🛑 *Trading Bot Stopped*${reason ? `\nReason: ${reason}` : ''}`;
        await this.sendTelegramMessage(message);
        await this.sendDiscordMessage(message);
    }
}

export const notifier = new Notifier();
