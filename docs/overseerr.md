# Overseerr Integration for NanoClaw

NanoClaw allows you to search for and request media (movies and TV shows) on your Overseerr instance directly from the AI agent.

## Setup

### 1. Get your Overseerr API Key
1. Log in to your Overseerr instance.
2. Go to **Settings** -> **General**.
3. Under **API Key**, click the copy icon.

### 2. Configure NanoClaw
Add the following variables to your `.env` file in the root of the project:

```env
# Overseerr Configuration
OVERSEER_URL=https://overseerr.example.com
OVERSEER_API=MTc0NDYyNzk4ODA0OWY1ODk4ZDg1LTEwM2YtNDdhMi1iNmRiLWNhN2VlMzYwYWU0ZQ==
```

> [!NOTE]
> NanoClaw supports both `OVERSEER_` and `OVERSEERR_` (with double R) prefixes for compatibility.

### 3. Restart NanoClaw
```bash
sudo systemctl restart nanoclaw
```

## Usage

You can ask the agent (either Claude or Gemini) to find or request media:

- **Searching**: "Can you see if Inception is available on overseerr?"
- **Requesting**: "Grab Terminator Genisys for me on overseerr."

### How it works
1. **Search**: The agent uses the `overseerr_search` tool to find the media and its unique ID.
2. **Request**: Once the ID is found, the agent uses the `overseerr_request` tool to submit the request to your Overseerr instance.

## Troubleshooting

- **"Overseerr URL is missing"**: Ensure `OVERSEER_URL` is correctly set in your root `.env` file.
- **"Overseerr API Key is missing"**: Ensure `OVERSEER_API` is correctly set in your root `.env` file.
- **Connection Errors**: Check if your Overseerr instance is accessible from the server running NanoClaw. If using Tailscale or a VPN, ensure the server is connected.
