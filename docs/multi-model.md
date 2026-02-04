# Multi-Model Support for NanoClaw

NanoClaw supports multiple AI model providers, allowing you to choose between Claude and Gemini on a per-group basis.

## Overview

| Provider | Best For | Cost | Notes |
|----------|----------|------|-------|
| **Claude** | Coding, complex reasoning, agentic tasks | Higher | Uses Claude Agent SDK with full tool support |
| **Gemini** | General questions, fast responses | Lower (~40x cheaper) | Uses Google Generative AI with basic tools |

## Quick Start

### 1. Set Up API Keys

Add the appropriate API keys to your `.env` file:

```bash
# For Claude (already configured if using existing setup)
CLAUDE_CODE_OAUTH_TOKEN=your_token_here
# OR
ANTHROPIC_API_KEY=your_api_key_here

# For Gemini
GOOGLE_API_KEY=your_google_api_key_here
# Optional: specify model (default: gemini-2.0-flash)
GEMINI_MODEL=gemini-2.0-flash
```

### 2. Build the Gemini Container

```bash
cd /path/to/nanoclaw/container
./build-all.sh
```

This builds both container images:
- `nanoclaw-agent:latest` (Claude)
- `nanoclaw-agent-gemini:latest` (Gemini)

### 3. Restart NanoClaw

```bash
sudo systemctl restart nanoclaw
```

## Usage

### Switching Models

Use the `/model` command from any chat:

| Command | Description |
|---------|-------------|
| `/model` or `/model status` | Show current model and settings |
| `/model claude` | Switch this group to Claude |
| `/model gemini` | Switch this group to Gemini |
| `/model reset` | Reset to global default |
| `/model global claude` | Set global default to Claude (main only) |
| `/model global gemini` | Set global default to Gemini (main only) |
| `/model help` | Show help |

### Examples

```
User: /model status
Bob: *Model Status*
Current: *claude*
Global default: claude
Available: claude, gemini

User: /model gemini
Bob: Switched to *gemini* for this group. Future messages will use gemini.

User: What's 2+2?
Bob: 4

User: /model claude
Bob: Switched to *claude* for this group. Future messages will use claude.
```

## Per-Group Configuration

Each group (WhatsApp chat, Discord channel, Telegram) can have its own model setting:

- **Main group**: Can set global defaults that apply to new groups
- **Other groups**: Can only change their own model, not affect others

This allows you to:
- Use Claude for your personal/coding chat
- Use Gemini for family group chats (cheaper)
- Use different models for different Discord channels

## Architecture

```
Message → Router → Provider Manager → Provider Factory
                        ↓                    ↓
                  Per-group config    Claude/Gemini Provider
                        ↓                    ↓
                  model_providers.json   Container execution
```

### Files

| File | Purpose |
|------|---------|
| `src/model-providers/` | Provider abstraction layer |
| `src/command-handler.ts` | `/model` command handling |
| `data/model_providers.json` | Persisted provider settings |
| `container/Dockerfile` | Claude container |
| `container/Dockerfile.gemini` | Gemini container |

## Gemini Capabilities

The Gemini agent has these tools:
- `read_file` - Read file contents
- `write_file` - Write content to files
- `run_command` - Execute shell commands
- `list_files` - List directory contents
- `send_message` - Send messages to the chat

Note: Gemini has fewer tools than Claude (no browser automation, no web search). For complex tasks requiring many tools, use Claude.

## Getting a Google API Key

1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Sign in with your Google account
3. Click "Get API Key" in the left sidebar
4. Create a new API key
5. Copy the key and add it to your `.env` file

## Troubleshooting

### "GOOGLE_API_KEY not set"

Make sure your `.env` file has:
```bash
GOOGLE_API_KEY=your_key_here
```

### Gemini container not found

Build the container:
```bash
cd container && ./build-all.sh
```

### Model switch not working

Check the logs:
```bash
sudo journalctl -u nanoclaw -f
```

Look for `Model provider switched` or errors.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GOOGLE_API_KEY` | Google AI API key for Gemini | - |
| `GEMINI_API_KEY` | Alias for GOOGLE_API_KEY | - |
| `GEMINI_MODEL` | Gemini model to use | `gemini-2.0-flash` |
| `GEMINI_CONTAINER_IMAGE` | Docker image for Gemini | `nanoclaw-agent-gemini:latest` |
| `CLAUDE_CONTAINER_IMAGE` | Docker image for Claude | `nanoclaw-agent:latest` |
