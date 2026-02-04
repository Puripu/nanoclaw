import { MessagingPlatform } from './types.js';
import { logger } from '../logger.js';

export class PlatformManager {
  private platforms: Map<string, MessagingPlatform> = new Map();

  registerPlatform(platform: MessagingPlatform): void {
    this.platforms.set(platform.name, platform);
    logger.info({ platform: platform.name }, 'Platform registered');
  }

  async startAll(): Promise<void> {
    const promises = Array.from(this.platforms.values()).map(async (platform) => {
      try {
        await platform.start();
        logger.info({ platform: platform.name }, 'Platform started');
      } catch (err) {
        logger.error({ platform: platform.name, err }, 'Failed to start platform');
      }
    });
    await Promise.all(promises);
  }

  getPlatformForJid(jid: string): MessagingPlatform | undefined {
    for (const platform of this.platforms.values()) {
      if (platform.isJidForPlatform(jid)) {
        return platform;
      }
    }
    return undefined;
  }

  getPlatformForGroup(groupFolder: string): MessagingPlatform | undefined {
    for (const platform of this.platforms.values()) {
      if (platform.isGroupForPlatform(groupFolder)) {
        return platform;
      }
    }
    return undefined;
  }

  async sendMessage(jid: string, text: string, sourceGroup?: string): Promise<void> {
    // Try to find by JID first
    let platform = this.getPlatformForJid(jid);

    // If not found and sourceGroup provided, try to find by source group (fallback)
    if (!platform && sourceGroup) {
      platform = this.getPlatformForGroup(sourceGroup);
    }

    if (platform) {
      await platform.sendMessage(jid, text);
    } else {
      logger.warn({ jid, sourceGroup }, 'No platform found for message');
    }
  }

  async sendPhoto(jid: string, imagePath: string, caption?: string, sourceGroup?: string): Promise<void> {
    let platform = this.getPlatformForJid(jid);

    if (!platform && sourceGroup) {
      platform = this.getPlatformForGroup(sourceGroup);
    }

    if (platform) {
      await platform.sendPhoto(jid, imagePath, caption);
    } else {
      logger.warn({ jid, sourceGroup }, 'No platform found for photo');
    }
  }
}

// Singleton instance
let instance: PlatformManager | null = null;

export function getPlatformManager(): PlatformManager {
  if (!instance) {
    instance = new PlatformManager();
  }
  return instance;
}
