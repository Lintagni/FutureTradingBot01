#!/bin/sh
set -e

echo "🔧 Running database migration..."
npx prisma db push

echo "🚀 Starting trading bot..."
node dist/index.js
