#!/usr/bin/env node

/**
 * Setup script for AI Crypto Trading Bot
 * Run this after npm install to complete setup
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 Setting up AI Crypto Trading Bot...\n');

// 1. Check if .env exists
const envPath = path.join(__dirname, '..', '.env');
const envExamplePath = path.join(__dirname, '..', '.env.example');

if (!fs.existsSync(envPath)) {
    console.log('📝 Creating .env file from .env.example...');
    fs.copyFileSync(envExamplePath, envPath);
    console.log('✅ .env file created\n');
    console.log('⚠️  IMPORTANT: Edit .env file with your API keys before running the bot!\n');
} else {
    console.log('✅ .env file already exists\n');
}

// 2. Create logs directory
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
    console.log('📁 Creating logs directory...');
    fs.mkdirSync(logsDir, { recursive: true });
    console.log('✅ Logs directory created\n');
}

// 3. Create models directory for future AI models
const modelsDir = path.join(__dirname, '..', 'models');
if (!fs.existsSync(modelsDir)) {
    console.log('📁 Creating models directory...');
    fs.mkdirSync(modelsDir, { recursive: true });

    // Create .gitkeep
    fs.writeFileSync(path.join(modelsDir, '.gitkeep'), '');
    console.log('✅ Models directory created\n');
}

// 4. Generate Prisma client
console.log('🔧 Generating Prisma client...');
try {
    execSync('npx prisma generate', { stdio: 'inherit' });
    console.log('✅ Prisma client generated\n');
} catch (error) {
    console.error('❌ Failed to generate Prisma client:', error.message);
    process.exit(1);
}

// 5. Initialize database
console.log('🗄️  Initializing database...');
try {
    execSync('npx prisma db push', { stdio: 'inherit' });
    console.log('✅ Database initialized\n');
} catch (error) {
    console.error('❌ Failed to initialize database:', error.message);
    process.exit(1);
}

console.log('✨ Setup complete!\n');
console.log('Next steps:');
console.log('1. Edit .env file with your Binance API keys');
console.log('2. For paper trading: Get testnet keys from https://testnet.binance.vision/');
console.log('3. Run: npm run paper-trade (to test with fake money)');
console.log('4. Run: npm start (for live trading - be careful!)\n');
console.log('📖 Read README.md for detailed instructions\n');
