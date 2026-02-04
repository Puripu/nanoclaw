# Discord Integration for NanoClaw

This guide explains how to set up a Discord bot to talk to NanoClaw in your Discord server.

## Overview

The Discord integration allows you to:
- Chat with NanoClaw in any channel where the bot is present
- Configure per-channel trigger modes (always respond vs. @mention only)
- Send photos and receive responses
- Use all NanoClaw capabilities (web search, file access, scheduled tasks)

## Setup Steps

### 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"**
3. Give it a name (e.g., "NanoClaw" or "Bob")
4. Click **"Create"**

### 2. Create a Bot User

1. In your application, go to the **"Bot"** section in the left sidebar
2. Click **"Add Bot"** and confirm
3. Under the bot's username, you'll see a **"Token"** section
4. Click **"Reset Token"** to generate a new token
5. **Copy this token** - you'll need it for the `.env` file

> **Important:** Never share your bot token publicly. It gives full control over your bot.

### 3. Configure Bot Permissions

In the **"Bot"** section:

1. Scroll down to **"Privileged Gateway Intents"**
2. Enable these intents:
   - **Message Content Intent** (required to read message text)
   - **Server Members Intent** (optional, for member info)
3. Click **"Save Changes"**

### 4. Generate Invite Link

1. Go to the **"OAuth2"** section, then **"URL Generator"**
2. Under **"Scopes"**, select:
   - `bot`
   - `applications.commands` (optional, for future slash commands)
3. Under **"Bot Permissions"**, select:
   - `Send Messages`
   - `Read Message History`
   - `Attach Files` (for sending images)
   - `Use External Emojis` (optional)
   - `Add Reactions` (optional)
4. Copy the generated URL at the bottom

### 5. Invite the Bot to Your Server

1. Open the invite URL in your browser
2. Select the server you want to add the bot to
3. Click **"Authorize"**
4. Complete the CAPTCHA if prompted

### 6. Configure NanoClaw

Add your Discord bot token to your `.env` file:

```bash
# Discord Bot Configuration
DISCORD_BOT_TOKEN=your_bot_token_here
```

### 7. Restart NanoClaw

```bash
sudo systemctl restart nanoclaw
```

Check the logs to confirm the bot connected:

```bash
sudo journalctl -u nanoclaw -f
```

You should see: `Discord bot logged in`

## Usage

### Talking to the Bot

By default, the bot responds when you @mention it:

```
@Bob what's the weather like today?
```

### Channel Modes

You can configure how the bot responds in each channel:

| Command | Description |
|---------|-------------|
| `!bob mode always` | Bot responds to every message in the channel |
| `!bob mode mention` | Bot only responds when @mentioned (default) |
| `!bob status` | Show current channel configuration |
| `!bob help` | Show available commands |

### Example Conversation

```
User: @Bob what time is it?
Bob: It's currently 3:45 PM UTC on February 4, 2026.

User: !bob mode always
Bob: Channel mode set to always. I will respond to all messages.

User: What's 2 + 2?
Bob: 4
```

## Per-Channel Configuration

Each channel maintains its own:
- **Mode setting** (always/mention)
- **Conversation history** (session persists per channel)

This means you can have:
- A "work" channel where Bob responds to everything
- A "general" channel where Bob only responds when mentioned

## Troubleshooting

### Bot Not Responding

1. **Check bot is online:** The bot should appear in the member list with a green dot
2. **Check intents:** Ensure "Message Content Intent" is enabled in the Developer Portal
3. **Check permissions:** The bot needs permission to read and send messages in the channel
4. **Check mode:** Run `!bob status` to see if the channel requires @mention

### "Missing Permissions" Error

The bot needs these permissions in the channel:
- View Channel
- Send Messages
- Read Message History
- Attach Files (for images)

### Bot Token Invalid

If you see authentication errors:
1. Go to the Developer Portal
2. Regenerate your bot token
3. Update `.env` with the new token
4. Restart NanoClaw

### Rate Limits

Discord has rate limits. If the bot stops responding temporarily, it may be rate-limited. Wait a minute and try again.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DISCORD_BOT_TOKEN` | Your Discord bot token | Yes |

## Data Storage

Discord data is stored in:
- `data/discord_state.json` - Sessions and channel configurations
- `groups/discord/` - Discord group workspace and logs
- `groups/discord/CLAUDE.md` - Bot's memory for Discord conversations

## Security Notes

1. **Token Security:** Keep your bot token secret. If compromised, regenerate it immediately.
2. **Server Privacy:** The bot only sees messages in channels it has access to.
3. **Session Isolation:** Discord conversations are isolated from WhatsApp/Telegram sessions.

## Advanced: Multiple Servers

The bot can be added to multiple Discord servers. Each channel across all servers maintains its own configuration and session.

## Updating the Bot

When you update NanoClaw, the Discord integration updates automatically. Just restart the service:

```bash
sudo systemctl restart nanoclaw
```
