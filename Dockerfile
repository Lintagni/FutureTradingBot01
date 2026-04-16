FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y openssl python3 build-essential && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install ALL dependencies (including devDeps for build)
RUN npm ci --ignore-scripts

# Copy source
COPY . .

# Generate Prisma client and build TypeScript
RUN npx prisma generate
RUN npx tsc

# ─── Production image ───
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy built output
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma/
COPY --from=builder /app/dashboard ./dashboard/

# Copy startup script
COPY start.sh ./start.sh
RUN chmod +x start.sh

# Railway injects PORT at runtime; expose it for documentation
EXPOSE ${PORT:-3000}

# Run DB migration then start bot
CMD ["sh", "start.sh"]
