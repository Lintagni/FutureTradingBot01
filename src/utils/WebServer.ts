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
            recentWinRate: status.recentWinRate,
            lifetimeWinRate: status.lifetimeWinRate,
            walletBalances: status.walletBalances instanceof Map
                ? Object.fromEntries(status.walletBalances)
                : status.walletBalances,
            mode: config.mode,
            leverage: config.futures.leverage,
            marginMode: config.futures.marginMode,
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
            ws.on('close', () => logger.info('Dashboard client disconnected'));
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
