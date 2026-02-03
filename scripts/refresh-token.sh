#!/bin/bash
# Refresh OAuth token from Claude credentials file
# Run via cron every hour to prevent token expiration

CREDENTIALS_FILE="$HOME/.claude/.credentials.json"
ENV_FILE="/home/ubuntu/claude/nanoclaw/.env"
ENV_DIR_FILE="/home/ubuntu/claude/nanoclaw/data/env/env"

if [ ! -f "$CREDENTIALS_FILE" ]; then
    echo "$(date): Credentials file not found: $CREDENTIALS_FILE"
    exit 1
fi

NEW_TOKEN=$(jq -r '.claudeAiOauth.accessToken' "$CREDENTIALS_FILE")

if [ -z "$NEW_TOKEN" ] || [ "$NEW_TOKEN" = "null" ]; then
    echo "$(date): Failed to extract token from credentials"
    exit 1
fi

# Get current token from env file
CURRENT_TOKEN=""
if [ -f "$ENV_DIR_FILE" ]; then
    CURRENT_TOKEN=$(grep CLAUDE_CODE_OAUTH_TOKEN "$ENV_DIR_FILE" | cut -d= -f2)
fi

# Only update if token changed
if [ "$NEW_TOKEN" != "$CURRENT_TOKEN" ]; then
    echo "$(date): Token changed, updating..."

    # Update data/env/env
    echo "CLAUDE_CODE_OAUTH_TOKEN=$NEW_TOKEN" > "$ENV_DIR_FILE"

    # Update .env file
    if [ -f "$ENV_FILE" ]; then
        sed -i "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$NEW_TOKEN|" "$ENV_FILE"
    fi

    echo "$(date): Token updated successfully"
else
    echo "$(date): Token unchanged, no update needed"
fi
