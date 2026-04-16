# ☁️ Deploying Your Trading Bot to a VPS

Running your bot on a **VPS (Virtual Private Server)** is the best way to ensure it runs 24/7 without interruption.

---

## 1. Choose a VPS Provider

You need a small linux server. The bot is lightweight, so the cheapest options usually work fine.

*   **DigitalOcean**: "Droplet" (Basic, Regular, $4-6/mo)
*   **Vultr**: "Cloud Compute" (Regular, $5/mo)
*   **Hetzner**: "Cloud" (CX22, ~€4/mo) - *Best value*
*   **AWS Lightsail**: ($3.50/mo)

**Recommended OS**: Ubuntu 22.04 LTS or 24.04 LTS.

---

## 2. Connect to Your Server

After buying the VPS, you will get an **IP Address** and a **Password** (or use an SSH key).

On Windows, open **PowerShell** or **Command Prompt**:

```bash
ssh root@YOUR_SERVER_IP
# Example: ssh root@192.168.1.50
```

*Type `yes` if asked to confirm fingerprint. Enter password when prompted (it won't show on screen).*

---

## 3. Install Node.js & Tools

Run these commands one by one to install Node.js (version 20) and Git:

```bash
# Update system
apt update && apt upgrade -y

# Install curl and git
apt install -y curl git Use

# Add Node.js repository
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -

# Install Node.js
apt install -y nodejs

# Verify installation
node -v
npm -v
```

---

## 4. Install PM2 (Process Manager)

PM2 allows your bot to run in the background 24/7 and automatically restarts it if it crashes or if the server reboots.

```bash
npm install -g pm2
```

---

## 5. Deploy Your Code

You can either use **Git** (recommended) or copy files manually.

### Option A: Using Git (Recommended)
1.  Upload your code to GitHub (private repo).
2.  Clone it on the VPS:
    ```bash
    git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
    cd YOUR_REPO
    ```
    *(You may need to generate an SSH key on the VPS and add it to GitHub).*

### Option B: Copy Files Manually (SCP)
If you don't want to use Git, use `scp` from your **local computer** to copy files:

```bash
# Run this from your project folder on your PC
scp -r src package.json tsconfig.json prisma .env.example root@YOUR_SERVER_IP:~/crypto-bot
```

Then on the **VPS**:
```bash
cd ~/crypto-bot
```

---

## 6. Install Dependencies & Setup

Inside your project folder on the VPS:

```bash
# Install libraries
npm install

# Initialize Database
npm run db:generate
npm run db:push
```

---

## 7. Configuration

Create your `.env` file with your real API keys:

```bash
nano .env
```

1.  Paste the contents of your `.env` file here.
2.  **Important**: Set `TRADING_MODE=paper` first to test!
3.  Press `Ctrl+X`, then `Y`, then `Enter` to save.

---

## 8. Start the Bot 🚀

Use PM2 to start the bot.

```bash
# Start the bot
pm2 start npm --name "crypto-bot" -- start

# Save the process list so it restarts on reboot
pm2 save
pm2 startup
```

---

## 9. Management & Monitoring

Since the bot is now running in the background, use PM2 commands to check on it.

*   **View Logs** (See what the bot is doing):
    ```bash
    pm2 logs crypto-bot
    ```
    *(Press `Ctrl+C` to exit logs)*

*   **Check Status**:
    ```bash
    pm2 status
    ```

*   **Stop Bot**:
    ```bash
    pm2 stop crypto-bot
    ```

*   **Restart Bot** (after changing config/code):
    ```bash
    pm2 restart crypto-bot
    ```

---

## 10. Controlling via Telegram

Once the bot is running on the VPS:
1.  Open your Telegram app on Android.
2.  Send `/start_bot` to your bot.
3.  Send `/status` to check if it's working.
4.  You now have full control from your phone! 📱
