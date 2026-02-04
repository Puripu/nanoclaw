---
name: enable-browser
description: Enable browser capabilities by exposing WebSearch/WebFetch tools and teaching the agent to use the agent-browser CLI.
---

# Enable Browser Capabilities

This skill ensures the agent has access to web tools and knows how to use the container's browser.

## Implementation

### Step 1: Enable Web Tools

Read `container/agent-runner-gemini/src/index.ts`.

Ensure the following tools are defined in the `tools` array and handled in `executeToolCall`:
- `web_search`
- `web_fetch`
- `use_browser`

### Step 2: Teach Agent about Browser CLI

Append to `groups/global/CLAUDE.md` (and `groups/discord/CLAUDE.md` if using Discord):

```markdown

## Browser Access

You have two ways to access the web:

1. **Simple Fetching**: Use `WebSearch` and `WebFetch` tools for simple queries and static content.
2. **Full Browser**: For dynamic sites, interactions, or screenshots, use the `agent-browser` CLI via `Bash`.

**Using agent-browser:**
- `agent-browser "url"` - Visit page and get interactive text representation
- `agent-browser --click @eID` - Click element (IDs are shown in output)
- `agent-browser --type @eID "text"` - Type text
- `agent-browser --help` - View all commands
```

### Step 3: Rebuild and Restart

```bash
cd container && ./build.sh && cd ..
npm run build
sudo systemctl restart nanoclaw
```