# NanoClaw

Personal AI assistant that connects to WhatsApp, Telegram, and Discord. Runs AI agents (Claude or Gemini) in isolated Docker containers with browser automation, web search, and scheduled tasks.

Based on [gavrielc/nanoclaw](https://github.com/gavrielc/nanoclaw) with significant additions.

## Features

### Multi-Platform Support
- **WhatsApp** - Primary platform via Baileys library
- **Telegram** - Full bot integration
- **Discord** - Bot with mention/always modes

### Multi-Model Support
- **Claude** - Best for coding and complex tasks (uses Claude Agent SDK)
- **Gemini** - Faster and cheaper for general questions

Switch models per-group with `/model claude` or `/model gemini`.

### Web Search
- **Brave Search API** - Fast, structured search results (primary)
- **Browser-based search** - Fallback using agent-browser

### Browser Automation
Both agents can interact with web pages using `agent-browser`:
- Navigate to URLs
- Click elements
- Fill forms
- Take screenshots

### Scheduled Tasks
Create recurring or one-time tasks via the agent:
- Cron expressions for specific times
- Intervals for periodic tasks
- One-time tasks for reminders

### Isolated Execution
Each group runs in its own Docker container with:
- Isolated filesystem (`/workspace/group/`)
- Separate session storage
- Per-group memory (`CLAUDE.md`)

## Commands

All platforms support these commands:

| Command | Description |
|---------|-------------|
| `/clear` or `/reset` | Clear conversation history and start fresh |
| `/model` | Show current AI model |
| `/model claude` | Switch to Claude |
| `/model gemini` | Switch to Gemini |
| `/model reset` | Use global default model |
| `/help` | Show available commands |

**Discord only:**
- `!bob mode always` - Respond to all messages in channel
- `!bob mode mention` - Only respond when @mentioned
- `!bob status` - Show channel configuration

## Setup

### Prerequisites
- Node.js 22+
- Docker
- API keys (see Environment Variables)

### Installation

```bash
git clone https://github.com/yourusername/nanoclaw.git
cd nanoclaw
npm install
npm run build
```

### Build Containers

```bash
cd container
./build-all.sh  # Builds both Claude and Gemini containers
```

### Environment Variables

Create a `.env` file:

```env
# AI Models (at least one required)
ANTHROPIC_API_KEY=sk-ant-...        # For Claude
GOOGLE_API_KEY=...                   # For Gemini
CLAUDE_CODE_OAUTH_TOKEN=...          # Alternative Claude auth

# Optional: Web Search
BRAVE_API_KEY=...                    # For Brave Search API

# Platforms (configure what you use)
TELEGRAM_BOT_TOKEN=...               # From @BotFather
DISCORD_BOT_TOKEN=...                # From Discord Developer Portal

# Optional Configuration
ASSISTANT_NAME=Bob                   # Bot's display name (default: Andy)
CONTAINER_TIMEOUT=300000             # Container timeout in ms (default: 5 min)
LOG_LEVEL=info                       # debug, info, warn, error
TZ=America/New_York                  # Timezone for scheduled tasks
```

### Running

```bash
npm run dev          # Development with hot reload
npm start            # Production
```

For WhatsApp, scan the QR code on first run to authenticate.

## Architecture

```
nanoclaw/
├── src/                    # Main application
│   ├── index.ts           # WhatsApp + message routing
│   ├── telegram.ts        # Telegram bot
│   ├── discord.ts         # Discord bot
│   ├── container-runner.ts # Spawns agent containers
│   ├── model-providers/   # Claude & Gemini providers
│   └── command-handler.ts # /model, /clear, /help
├── container/
│   ├── agent-runner/      # Claude agent code
│   ├── agent-runner-gemini/ # Gemini agent code
│   ├── Dockerfile         # Claude container
│   └── Dockerfile.gemini  # Gemini container
├── groups/                # Per-group workspaces
│   ├── main/             # Main WhatsApp group
│   ├── telegram/         # Telegram workspace
│   └── discord/          # Discord workspace
└── data/                  # Runtime state
    ├── sessions/         # Claude sessions per group
    └── ipc/              # Inter-process communication
```

## API Keys

### Brave Search API
Get a free API key at https://brave.com/search/api/

Used for fast web searches. Falls back to browser-based search if not configured.

### Telegram Bot
1. Message @BotFather on Telegram
2. Send `/newbot` and follow prompts
3. Copy the token to `TELEGRAM_BOT_TOKEN`

### Discord Bot
1. Go to https://discord.com/developers/applications
2. Create application, add bot
3. Enable MESSAGE CONTENT INTENT
4. Copy token to `DISCORD_BOT_TOKEN`
5. Invite bot with `applications.read`, `bot` scopes and `Send Messages`, `Read Message History` permissions

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build-all.sh  # Rebuild containers after changes
```

## Credits

- Original [nanoclaw](https://github.com/gavrielc/nanoclaw) by gavrielc
- Built with Claude Code and Gemini
