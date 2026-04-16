import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { logger } from './logger';
import { config } from '../config/trading.config';

export class WebServer {
    private app: express.Application;
    private server: http.Server;
    private wss: WebSocketServer;
    private port: number;

    constructor(port: number = 3000) {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({ server: this.server });
        this.port = port;

        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }

    private setupMiddleware() {
        this.app.use(express.json());
        // Serve static files from the dashboard directory
        const staticPath = path.join(process.cwd(), 'dashboard');
        this.app.use(express.static(staticPath));
    }

    private setupRoutes() {
        // API Endpoints
        this.app.get('/api/status', (_req, res) => {
            res.json({ status: 'running', mode: config.mode });
        });

        // Catch-all to serve index.html for SPA
        this.app.get('*', (_req, res) => {
            const indexPath = path.join(process.cwd(), 'dashboard', 'index.html');
            res.sendFile(indexPath);
        });
    }

    private setupWebSocket() {
        this.wss.on('connection', (ws: WebSocket) => {
            logger.info('Dashboard client connected via WebSocket');

            ws.send(JSON.stringify({ type: 'hello', message: 'Connected to Trading Bot' }));

            ws.on('close', () => {
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

    public start() {
        this.server.listen(this.port, () => {
            logger.info(`🌐 Web Dashboard available at http://localhost:${this.port}`);
        });
    }

    public stop() {
        this.server.close();
    }
}

export const webServer = new WebServer();
