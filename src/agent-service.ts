import { RegisteredGroup } from './types.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot, AvailableGroup } from './container-runner.js';
import { getAllTasks, getMessagesSince, getAllChats } from './db.js';
import { sessions, registeredGroups, lastAgentTimestamp, updateSession, updateLastAgentTimestamp } from './state.js';
import { ASSISTANT_NAME, MAIN_GROUP_FOLDER, TRIGGER_PATTERN } from './config.js';
import { logger } from './logger.js';
import { escapeXml } from './utils.js';
import { getPlatformManager } from './platforms/manager.js';

export class AgentService {
  /**
   * Get available groups list for the agent.
   */
  private getAvailableGroups(): AvailableGroup[] {
    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(registeredGroups));

    return chats
      .filter(c => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us')) // basic filtering, might need adjustment for other platforms
      .map(c => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid)
      }));
  }

  /**
   * Run the agent for a specific group and prompt.
   */
  async runAgent(group: RegisteredGroup, prompt: string, chatJid: string): Promise<string | null> {
    const isMain = group.folder === MAIN_GROUP_FOLDER;
    const sessionId = sessions[group.folder];

    // Update tasks snapshot for container to read (filtered by group)
    const tasks = getAllTasks();
    writeTasksSnapshot(group.folder, isMain, tasks.map(t => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run
    })));

    // Update available groups snapshot (main group only can see all groups)
    const availableGroups = this.getAvailableGroups();
    writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

    try {
      const output = await runContainerAgent(group, {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain
      });

      if (output.newSessionId) {
        updateSession(group.folder, output.newSessionId);
      }

      if (output.status === 'error') {
        logger.error({ group: group.name, error: output.error }, 'Container agent error');
        return null;
      }

      return output.result;
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return null;
    }
  }

  /**
   * Process a message from any platform.
   * This is the entry point for all incoming messages.
   */
  async processMessage(
    jid: string,
    senderName: string,
    content: string,
    timestamp: string,
    platformName: string
  ): Promise<void> {
    // Find the group registration for this JID
    let group = registeredGroups[jid];

    // Auto-registration for non-WhatsApp platforms if configured (or just use default folders)
    // For Telegram/Discord, we might have a static mapping or allow dynamic registration.
    // In current code, Telegram uses TELEGRAM_GROUP_FOLDER.
    // We should probably check if we can map it dynamically or use the passed group config.

    // Fallback logic for Telegram/Discord static groups if not explicitly registered
    if (!group) {
        // This logic mimics the original hardcoded behavior
        if (platformName === 'Telegram' && jid.includes('telegram')) {
            // Check if we have a group for telegram folder
             // The original code created a RegisteredGroup object on the fly or used a global one
             // Here we can rely on `registeredGroups` being populated by the platforms on start
        }
    }

    if (!group) {
        // If not registered, we ignore it (unless main group? but main group must be registered)
        return;
    }

    const cleanContent = content.trim();
    const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

    // Trigger check
    // Main group responds to all messages
    // Other groups require trigger prefix (unless configured otherwise in the platform, e.g. Discord "always" mode)
    // We'll assume the caller (Platform) has already decided if we SHOULD process it based on platform-specific rules (like @mention)
    // BUT, for WhatsApp, the trigger check was here.

    // If it's WhatsApp (which relies on this shared logic for triggers), we check.
    // For Telegram/Discord, they invoke this ONLY when they want a response.
    // So we can probably skip the trigger check here if we trust the caller,
    // OR we standardize.

    // Let's assume the Platform checks for "Intent to communicate".
    // But for WhatsApp "main group", everything is intent.
    // For WhatsApp "other group", trigger pattern is intent.

    // So, if the Platform says "process this", we process it.
    // EXCEPT: We still need to handle the history context.

    // Get all messages since last agent interaction so the session has full context
    const sinceTimestamp = lastAgentTimestamp[jid] || '';

    // We need to fetch messages from DB for context.
    // WhatsApp stores everything in DB.
    // Telegram/Discord currently DON'T store history in DB in the same way.
    // If we want "Same options and possibilities", Telegram/Discord should probably also have context.
    // But `getMessagesSince` queries the SQLite DB.

    // For now, if it's not WhatsApp, we might just use the current message as prompt (as in original code).
    // Or we construct a "messages" prompt from the single message.

    let prompt: string;

    if (platformName === 'WhatsApp') {
        const missedMessages = getMessagesSince(jid, sinceTimestamp, ASSISTANT_NAME);
        const lines = missedMessages.map(m => {
            return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
        });
        // Include the current message if it's not in DB yet?
        // In index.ts, processMessage was called with a message that came from getNewMessages, so it IS in DB.

        prompt = `<messages>\n${lines.join('\n')}\n</messages>`;
        if (missedMessages.length === 0) {
             // Fallback if DB query returns nothing (shouldn't happen if msg is in DB)
             prompt = `<message sender="${escapeXml(senderName)}" time="${timestamp}">${escapeXml(cleanContent)}</message>`;
        }
    } else {
        // Telegram/Discord style context
        // Original code:
        // Telegram: <message from="User" timestamp="...">text</message>
        // Discord: <message from="User" timestamp="..." channel="...">text</message>

        prompt = `<message from="${escapeXml(senderName)}" timestamp="${timestamp}" platform="${platformName}">\n${escapeXml(cleanContent)}\n</message>`;
    }

    logger.info({ group: group.name, platform: platformName }, 'Processing message');

    const platformManager = getPlatformManager();
    const platform = platformManager.getPlatformForJid(jid);

    // Typing indicator handled by platform wrapper usually, but we can do it here if platform exposes it?
    // Platform interface doesn't have setTyping. We can ignore it or add it.
    // We'll ignore it for now or assume platform handles it before calling us.

    const response = await this.runAgent(group, prompt, jid);

    if (response) {
      updateLastAgentTimestamp(jid, timestamp);

      // Use PlatformManager to send response
      if (platform) {
          await platform.sendMessage(jid, `${ASSISTANT_NAME}: ${response}`);
      } else {
          logger.warn({ jid }, 'No platform found to send response');
      }
    }
  }
}

// Singleton
let instance: AgentService | null = null;
export function getAgentService(): AgentService {
  if (!instance) {
    instance = new AgentService();
  }
  return instance;
}
