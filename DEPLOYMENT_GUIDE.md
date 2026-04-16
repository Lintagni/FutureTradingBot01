# Antigravity Trading Bot - Portable Deployment & Dashboard

This bot is now fully portable and accessible from any device, including Android and other laptops.

## 🚀 Easy Deployment (Docker)

To run the bot on any device, simply install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and run:

```powershell
docker-compose up -d
```

The bot will automatically:
1. Initialize the database.
2. Synchronize time with Bybit.
3. Start the Web Dashboard.

## 📱 Accessing from Android

To monitor and control the bot from your phone:

1. **Find your PC's IP Address**:
   - On Windows, run `ipconfig` in CMD. Look for "IPv4 Address" (e.g., `192.168.1.15`).
2. **Open your Phone browser**:
   - Go to `http://<YOUR-IP>:3000`.
3. **Control**:
   - Use the high-quality dashboard to see live P&L, stop-loss updates, and trade activity.

## 🛠️ Antigravity Workflows

I have set up specialized workflows so that I can update and manage the bot for you:
- `/redeploy`: Rebuilds and restarts the bot to pick up any changes.
- `/update_config`: Safely updates your API keys or risk settings.

## 🖥️ Local Dashboard
If you are on the same PC where the bot is running, you can always access it at:
[http://localhost:3000](http://localhost:3000)
