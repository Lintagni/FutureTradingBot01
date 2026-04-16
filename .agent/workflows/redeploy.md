---
description: Redeploy the trading bot via Docker to pick up latest changes
---

This workflow rebuilds the Docker container and restarts the service. Use this after making code changes or when moving the bot to a new device.

// turbo-all
1. Generate the Prisma client to ensure database schema is up to date:
```powershell
npx prisma generate
```

2. Build and restart the container in detached mode:
```powershell
docker-compose up --build -d
```

3. Verify the container is running:
```powershell
docker ps | grep trading-bot
```

4. Check the logs to ensure successful startup:
```powershell
docker logs trading-bot --tail 20
```
