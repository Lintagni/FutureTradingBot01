import winston from 'winston';
import { config } from '../config/trading.config';

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
);

const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(meta).length > 0) {
            msg += ` ${JSON.stringify(meta)}`;
        }
        return msg;
    })
);

const transports: winston.transport[] = [];

// Console transport
if (config.logging.console) {
    transports.push(
        new winston.transports.Console({
            format: consoleFormat,
        })
    );
}

// File transports
if (config.logging.file) {
    transports.push(
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            format: logFormat,
        }),
        new winston.transports.File({
            filename: 'logs/combined.log',
            format: logFormat,
        })
    );
}

export const logger = winston.createLogger({
    level: config.logging.level,
    format: logFormat,
    transports,
});

// Create specialized loggers for different components
export const tradeLogger = logger.child({ component: 'trade' });
export const strategyLogger = logger.child({ component: 'strategy' });
export const exchangeLogger = logger.child({ component: 'exchange' });
export const riskLogger = logger.child({ component: 'risk' });
export const aiLogger = logger.child({ component: 'ai' });
