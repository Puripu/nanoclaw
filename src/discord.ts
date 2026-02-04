/**
 * Discord Bot Integration for NanoClaw
 * Handles incoming messages from Discord and routes them to Claude
 */

import { Client, GatewayIntentBits, Message, TextChannel, Partials } from 'discord.js';
import path from 'path';
import fs from 'fs';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { RegisteredGroup } from './types.js';
import { runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { getAllTasks } from './db.js';
import { loadJson, saveJson, escapeXml } from './utils.js';
import { logger } from './logger.js';
import { handleCommand } from './command-handler.js';
import { getProviderManager } from './model-providers/index.js';

export const DISCORD_GROUP_FOLDER = 'discord';
export const DISCORD_JID_PREFIX = 'discord-';

// Channel configuration for trigger modes
export interface DiscordChannelConfig {
  mode: 'mention' | 'always';  // 'mention' = @bot required, 'always' = respond to all
  enabled: boolean;
}

interface DiscordState {
  sessions: Record<string, string>;           // channelId -> sessionId
  lastAgentTimestamp: Record<string, string>; // channelId -> timestamp
  channelConfigs: Record<string, DiscordChannelConfig>; // channelId -> config
  defaultMode: 'mention' | 'always';
}

// Store bot instance for IPC message sending
let discordClient: Client | null = null;
let discordState: DiscordState = {
  sessions: {},
  lastAgentTimestamp: {},
  channelConfigs: {},
  defaultMode: 'mention'  // Default: require @mention
};

function getStatePath(): string {
  return path.join(DATA_DIR, 'discord_state.json');
}

function loadDiscordState(): void {
  const state = loadJson<Partial<DiscordState>>(getStatePath(), {});
  discordState = {
    sessions: state.sessions || {},
    lastAgentTimestamp: state.lastAgentTimestamp || {},
    channelConfigs: state.channelConfigs || {},
    defaultMode: state.defaultMode || 'mention'
  };
}

function saveDiscordState(): void {
  saveJson(getStatePath(), discordState);
}

/**
 * Get the trigger mode for a channel
 */
function getChannelMode(channelId: string): 'mention' | 'always' {
  const config = discordState.channelConfigs[channelId];
  if (config && !config.enabled) return 'mention'; // Disabled channels require mention (won't respond)
  return config?.mode || discordState.defaultMode;
}

/**
 * Set the trigger mode for a channel
 */
export function setChannelMode(channelId: string, mode: 'mention' | 'always', enabled = true): void {
  discordState.channelConfigs[channelId] = { mode, enabled };
  saveDiscordState();
  logger.info({ channelId, mode, enabled }, 'Discord channel mode updated');
}

/**
 * Set the default mode for new channels
 */
export function setDefaultMode(mode: 'mention' | 'always'): void {
  discordState.defaultMode = mode;
  saveDiscordState();
  logger.info({ mode }, 'Discord default mode updated');
}

// Create group folder if it doesn't exist
function ensureDiscordFolder(): void {
  const groupDir = path.join(DATA_DIR, '..', 'groups', DISCORD_GROUP_FOLDER);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Create CLAUDE.md if it doesn't exist
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, `# ${ASSISTANT_NAME}

You are ${ASSISTANT_NAME}, a personal assistant communicating via Discord.

## What You Can Do

- Answer questions and have conversations
- Search the web and fetch content from URLs
- Read and write files in your workspace
- Run bash commands in your sandbox
- Schedule tasks to run later or on a recurring basis
- Send messages back to the chat

## Your Workspace

Files you create are saved in \`/workspace/group/\`. Use this for notes, research, or anything that should persist.

Your \`CLAUDE.md\` file in that folder is your memory - update it with important context you want to remember.

## Discord Formatting

Use Discord-compatible markdown:
- **bold** (double asterisks)
- *italic* (single asterisks)
- \`code\` (backticks)
- \`\`\`code blocks\`\`\` (triple backticks)
- > quotes (greater than)

Keep messages concise and readable. Discord has a 2000 character limit per message.

## Bot Commands

Users can configure the bot with these commands:
- \`!bob mode always\` - Respond to all messages in this channel
- \`!bob mode mention\` - Only respond when @mentioned (default)
- \`!bob status\` - Show current channel configuration
`);
    logger.info({ path: claudeMdPath }, 'Created Discord CLAUDE.md');
  }
}

export async function startDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.info('DISCORD_BOT_TOKEN not set, skipping Discord bot');
    return;
  }

  loadDiscordState();
  ensureDiscordFolder();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel] // Required for DMs
  });

  // Create a registered group entry for Discord
  const discordGroup: RegisteredGroup = {
    name: 'Discord',
    folder: DISCORD_GROUP_FOLDER,
    trigger: '', // Trigger handled per-channel
    added_at: new Date().toISOString()
  };

  client.on('ready', () => {
    logger.info({ user: client.user?.tag }, 'Discord bot logged in');
  });

  client.on('messageCreate', async (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const userId = message.author.id;
    const username = message.author.displayName || message.author.username;
    const content = message.content;

    // Handle bot commands
    if (content.startsWith('!bob ')) {
      await handleBotCommand(message);
      return;
    }

    // Handle slash commands (/model, /clear, /reset, /help)
    if (content.startsWith('/')) {
      const result = handleCommand(content, DISCORD_GROUP_FOLDER, false);
      if (result.handled) {
        // Clear session state if requested
        if (result.clearSession) {
          const providerName = getProviderManager().getProviderForGroup(DISCORD_GROUP_FOLDER);
          const sessionKey = `${providerName}-discord-${channelId}`;
          delete discordState.sessions[sessionKey];
          saveDiscordState();
          logger.info({ channelId, sessionKey }, 'Discord session cleared');
        }
        if (result.response) {
          await message.reply(result.response);
        }
        return;
      }
    }

    // Check if we should respond
    const mode = getChannelMode(channelId);
    const isMentioned = message.mentions.has(client.user!);

    // In mention mode, only respond if @mentioned
    if (mode === 'mention' && !isMentioned) {
      return;
    }

    // Remove the @mention from the message if present
    let cleanContent = content;
    if (isMentioned && client.user) {
      cleanContent = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    }

    // Don't respond to empty messages after removing mention
    if (!cleanContent) return;

    logger.info({ channelId, userId, username, contentLength: cleanContent.length, mode }, 'Discord message received');

    // Send typing indicator
    try {
      await (message.channel as TextChannel).sendTyping();
    } catch (err) {
      logger.debug({ err }, 'Failed to send typing indicator');
    }

    try {
      // Get or create session for this channel (provider-aware to avoid cross-provider session issues)
      const providerName = getProviderManager().getProviderForGroup(DISCORD_GROUP_FOLDER);
      const sessionKey = `${providerName}-discord-${channelId}`;
      const sessionId = discordState.sessions[sessionKey];

      // Write tasks snapshot for the container
      const tasks = getAllTasks();
      writeTasksSnapshot(DISCORD_GROUP_FOLDER, false, tasks.map(t => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run
      })));

      // Build prompt with context
      const prompt = `<message from="${escapeXml(username)}" timestamp="${new Date().toISOString()}" channel="${escapeXml(channelId)}">\n${escapeXml(cleanContent)}\n</message>`;

      const result = await runContainerAgent(discordGroup, {
        prompt,
        sessionId,
        groupFolder: DISCORD_GROUP_FOLDER,
        chatJid: `${DISCORD_JID_PREFIX}${channelId}`,
        isMain: false,
        isScheduledTask: false
      });

      // Update session
      if (result.newSessionId) {
        discordState.sessions[sessionKey] = result.newSessionId;
        saveDiscordState();
      }

      discordState.lastAgentTimestamp[sessionKey] = new Date().toISOString();
      saveDiscordState();

      if (result.status === 'success' && result.result) {
        await sendDiscordResponse(message, result.result);
      } else if (result.error) {
        logger.error({ error: result.error }, 'Agent error');
        await message.reply(`Sorry, I encountered an error:\n\n${result.error.slice(0, 1500)}`);
      }
    } catch (err) {
      logger.error({ err }, 'Error processing Discord message');
      await message.reply('Sorry, something went wrong. Please try again.');
    }
  });

  // Login to Discord
  await client.login(token);
  logger.info('Discord bot started');

  // Store client instance for IPC
  discordClient = client;
}

/**
 * Handle bot configuration commands
 */
async function handleBotCommand(message: Message): Promise<void> {
  const args = message.content.slice(5).trim().split(/\s+/);
  const command = args[0]?.toLowerCase();

  switch (command) {
    case 'mode': {
      const mode = args[1]?.toLowerCase();
      if (mode === 'always' || mode === 'mention') {
        setChannelMode(message.channel.id, mode);
        await message.reply(`Channel mode set to **${mode}**. ${mode === 'always' ? 'I will respond to all messages.' : 'I will only respond when @mentioned.'}`);
      } else {
        await message.reply('Usage: `!bob mode <always|mention>`\n- `always`: Respond to all messages\n- `mention`: Only respond when @mentioned');
      }
      break;
    }
    case 'status': {
      const config = discordState.channelConfigs[message.channel.id];
      const mode = config?.mode || discordState.defaultMode;
      const enabled = config?.enabled !== false;
      await message.reply(`**Channel Status**\n- Mode: ${mode}\n- Enabled: ${enabled}\n- Default mode: ${discordState.defaultMode}`);
      break;
    }
    case 'help':
    default:
      await message.reply(`**${ASSISTANT_NAME} Commands**\n` +
        '- `!bob mode always` - Respond to all messages\n' +
        '- `!bob mode mention` - Only respond when @mentioned\n' +
        '- `!bob status` - Show current channel configuration');
  }
}

/**
 * Send a response, splitting if necessary (Discord 2000 char limit)
 */
async function sendDiscordResponse(message: Message, response: string): Promise<void> {
  const maxLength = 1900; // Leave room for formatting

  if (response.length <= maxLength) {
    await message.reply(response);
  } else {
    // Split into chunks, trying to break at newlines
    const chunks: string[] = [];
    let remaining = response;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to find a good break point
      let breakPoint = remaining.lastIndexOf('\n', maxLength);
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = maxLength;
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }

    // Send first chunk as reply, rest as follow-ups
    await message.reply(chunks[0]);
    const channel = message.channel as TextChannel;
    for (let i = 1; i < chunks.length; i++) {
      await channel.send(chunks[i]);
    }
  }
}

/**
 * Send a text message via Discord
 */
export async function sendDiscordMessage(channelId: string, text: string): Promise<void> {
  if (!discordClient) {
    logger.warn('Discord client not initialized, cannot send message');
    return;
  }

  try {
    // Extract channel ID from JID format if needed
    const actualChannelId = channelId.startsWith(DISCORD_JID_PREFIX)
      ? channelId.slice(DISCORD_JID_PREFIX.length)
      : channelId;

    const channel = await discordClient.channels.fetch(actualChannelId);
    if (!channel || !('send' in channel)) {
      logger.error({ channelId: actualChannelId }, 'Discord channel not found or cannot send messages');
      return;
    }

    const sendableChannel = channel as TextChannel;
    const maxLength = 1900;
    if (text.length <= maxLength) {
      await sendableChannel.send(text);
    } else {
      // Split long messages
      const chunks = text.match(new RegExp(`.{1,${maxLength}}`, 'gs')) || [];
      for (const chunk of chunks) {
        await sendableChannel.send(chunk);
      }
    }
    logger.info({ channelId: actualChannelId }, 'Discord message sent via IPC');
  } catch (err) {
    logger.error({ err, channelId }, 'Failed to send Discord message');
  }
}

/**
 * Send a photo/image via Discord
 */
export async function sendDiscordPhoto(channelId: string, imagePath: string, caption?: string): Promise<void> {
  if (!discordClient) {
    logger.warn('Discord client not initialized, cannot send photo');
    return;
  }

  try {
    const actualChannelId = channelId.startsWith(DISCORD_JID_PREFIX)
      ? channelId.slice(DISCORD_JID_PREFIX.length)
      : channelId;

    const channel = await discordClient.channels.fetch(actualChannelId);
    if (!channel || !('send' in channel)) {
      logger.error({ channelId: actualChannelId }, 'Discord channel not found or cannot send messages');
      return;
    }

    const sendableChannel = channel as TextChannel;
    await sendableChannel.send({
      content: caption,
      files: [imagePath]
    });
    logger.info({ channelId: actualChannelId, imagePath }, 'Discord photo sent via IPC');
  } catch (err) {
    logger.error({ err, channelId, imagePath }, 'Failed to send Discord photo');
  }
}

/**
 * Check if this is a Discord chat JID
 */
export function isDiscordJid(jid: string): boolean {
  return jid.startsWith(DISCORD_JID_PREFIX);
}
