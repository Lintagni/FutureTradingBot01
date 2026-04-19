import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { logger } from './logger';
import { config } from '../config/trading.config';
import { tradeRepository } from '../database/TradeRepository';

export class WebServer {
    private app: express.Application;
    private server: http.Server;
    private wss: WebSocketServer;
    private port: number;
    private engine: any = null;
    private broadcastInterval: NodeJS.Timeout | null = null;

    constructor() {
        // Railway injects PORT automatically; fall back to 3000 for local dev
        this.port = parseInt(process.env.PORT || '3000', 10);
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({ server: this.server });

        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }

    /** Call this after the TradingEngine is ready so API endpoints serve real data */
    registerEngine(engine: any) {
        this.engine = engine;
        // Push fresh state to all connected dashboards every 5 s
        this.broadcastInterval = setInterval(() => this.broadcastState(), 5000);
    }

    private async broadcastState() {
        if (!this.engine || this.wss.clients.size === 0) return;
        try {
            const status = await this.engine.getStatus();
            this.broadcast('state', this.serializeStatus(status));
        } catch (_) { /* ignore */ }
    }

    private serializeStatus(status: any) {
        return {
            isRunning: status.isRunning,
            openPositions: status.openPositions,
            positionDetails: status.positionDetails,
            monitoredPairs: status.monitoredPairs,
            dailyPnL: status.dailyPnL,
            totalPnL: status.totalPnL,
            unrealizedPnL: status.unrealizedPnL,
            recentWinRate: status.recentWinRate,
            lifetimeWinRate: status.lifetimeWinRate,
            walletBalances: status.walletBalances instanceof Map
                ? Object.fromEntries(status.walletBalances)
                : status.walletBalances,
            mode: config.mode,
            leverage: config.futures.leverage,
            marginMode: config.futures.marginMode,
            readiness: status.readiness,
        };
    }

    private setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.static(path.join(process.cwd(), 'dashboard')));
    }

    private setupRoutes() {
        // ── Status ──────────────────────────────────────────────────────────
        this.app.get('/api/status', async (_req, res) => {
            if (!this.engine) {
                res.json({ status: 'initializing', mode: config.mode });
                return;
            }
            try {
                const status = await this.engine.getStatus();
                res.json(this.serializeStatus(status));
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        // ── Recent closed trades ─────────────────────────────────────────────
        this.app.get('/api/trades', async (req, res) => {
            try {
                const limit = Math.min(parseInt((req.query.limit as string) || '30', 10), 100);
                const trades = await tradeRepository.getRecentTrades(limit, 'futures');
                res.json(trades);
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        // ── Config (read-only) ───────────────────────────────────────────────
        this.app.get('/api/config', (_req, res) => {
            res.json({
                mode:                   config.mode,
                leverage:               config.futures.leverage,
                marginMode:             config.futures.marginMode,
                maxOpenPositions:       config.risk.maxOpenPositions,
                stopLossPercentage:     config.risk.stopLossPercentage,
                takeProfitPercentage:   config.risk.takeProfitPercentage,
                maxDailyLoss:           config.risk.maxDailyLoss,
                minPositionSize:        config.risk.minPositionSize,
                maxPositionSize:        config.risk.maxPositionSize,
                positionSizePercent:    config.risk.positionSizePercentage * 100,
                autoPairSelection:      config.autoPairSelection,
                maxActivePairs:         config.scanner.maxActivePairs,
                scanIntervalMinutes:    config.scanner.scanIntervalMinutes,
                minDailyVolumeUSD:      config.scanner.minDailyVolumeUSD,
                mlConfidenceThreshold:  config.strategy.mlConfidenceThreshold,
                trailingActivation:     config.strategy.trailingStopActivation,
                trailingDistance:       config.strategy.trailingStopDistance,
                breakEvenActivation:    config.strategy.breakEvenActivation,
                stalePositionHours:     config.strategy.stalePositionHours,
                timeframe:              config.timeframe,
                tradingPairs:           config.tradingPairs,
            });
        });

        // ── Settings (writable) ──────────────────────────────────────────────
        this.app.post('/api/settings/min-size', async (req, res) => {
            if (!this.engine) { res.json({ ok: false, message: 'Engine not ready' }); return; }
            const size = parseFloat(req.body.value);
            if (isNaN(size) || size <= 0) { res.json({ ok: false, message: 'Invalid value' }); return; }
            try {
                const msg = await this.engine.updateMinPositionSize(size);
                res.json({ ok: true, message: msg });
            } catch (e: any) {
                res.status(500).json({ ok: false, message: e.message });
            }
        });

        // ── Bot control ──────────────────────────────────────────────────────
        this.app.post('/api/start', async (_req, res) => {
            if (!this.engine) { res.json({ ok: false, message: 'Engine not ready' }); return; }
            try {
                await this.engine.start();
                res.json({ ok: true });
            } catch (e: any) {
                res.status(500).json({ ok: false, message: e.message });
            }
        });

        this.app.post('/api/stop', (_req, res) => {
            if (!this.engine) { res.json({ ok: false, message: 'Engine not ready' }); return; }
            this.engine.stop('Dashboard stop button');
            res.json({ ok: true });
        });

        // ── SPA fallback ─────────────────────────────────────────────────────
        this.app.get('*', (_req, res) => {
            res.sendFile(path.join(process.cwd(), 'dashboard', 'index.html'));
        });
    }

    private setupWebSocket() {
        this.wss.on('connection', (ws: WebSocket) => {
            logger.info('Dashboard client connected');
            ws.send(JSON.stringify({ type: 'connected', mode: config.mode }));
            // Send current state immediately on connect
            this.broadcastState();

            // Keep-alive pings every 25 s — Fly.io proxy closes idle WS after ~60 s
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.ping();
            }, 25000);

            ws.on('pong', () => {}); // connection confirmed alive
            ws.on('close', () => {
                clearInterval(pingInterval);
                logger.info('Dashboard client disconnected');
            });
        });
    }

    public broadcast(type: string, data: any) {
        const message = JSON.stringify({ type, data });
        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    /** Push a log line to all connected dashboards */
    public pushLog(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
        this.broadcast('log', { msg, level });
    }

    public start() {
        this.server.listen(this.port, '0.0.0.0', () => {
            logger.info(`🌐 Web Dashboard running on port ${this.port}`);
        });
    }

    public stop() {
        if (this.broadcastInterval) clearInterval(this.broadcastInterval);
        this.server.close();
    }
}

export const webServer = new WebServer();
