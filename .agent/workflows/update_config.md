---
description: Update bot configuration securely
---

Use this workflow to update `.env` variables (like API keys or risk parameters) and restart the bot to apply them.

1. View the current `.env` file to identify the field to change:
```powershell
cat .env
```

2. Update the specific line in `.env` using the `replace_file_content` tool.

3. Restart the bot to apply the new configuration:
// turbo
```powershell
docker-compose restart bot
```

4. Verify the bot started correctly:
```powershell
docker logs trading-bot --tail 10
```
