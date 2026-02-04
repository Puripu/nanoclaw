import { execSync } from 'child_process';
import { initDatabase } from './db.js';
import { loadState, registeredGroups, sessions } from './state.js';
import { logger } from './logger.js';
import {
  getPlatformManager,
  WhatsAppPlatform,
  TelegramPlatform,
  DiscordPlatform
} from './platforms/index.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { startIpcWatcher } from './ipc-watcher.js';

function ensureContainerSystemRunning(): void {
  const isMac = process.platform === 'darwin';

  // 1. Check for Docker (cross-platform)
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.info('Container runtime: docker');
    return;
  } catch (dockerErr) {
    // Try full path fallback
    try {
      execSync('/usr/bin/docker info', { stdio: 'pipe', timeout: 10000 });
      logger.info('Container runtime: docker (/usr/bin/docker)');
      return;
    } catch {
      if (!isMac) {
        // On Linux, we only have Docker. If it failed, warn.
        try {
          execSync('which docker', { stdio: 'ignore' });
          logger.warn('Docker binary found but daemon check failed. Agents will likely fail to start.');
          return;
        } catch {
          // No docker binary either
        }
      }
    }
  }

  // 2. Try Apple Container (macOS only)
  if (isMac) {
    try {
      execSync('container system status', { stdio: 'pipe' });
      logger.info('Container runtime: Apple Container');
      return;
    } catch {
      logger.info('Starting Apple Container system...');
      try {
        execSync('container system start', { stdio: 'pipe', timeout: 30000 });
        logger.info('Apple Container system started');
        return;
      } catch (err) {
        logger.error({ err }, 'Failed to start Apple Container system');
      }
    }
  }

  // Neither runtime available
  console.error('\n╔════════════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: No container runtime available                         ║');
  console.error('║                                                                ║');
  console.error('║  Agents require Docker or Apple Container. To fix:            ║');
  console.error('║  - Docker: Install and start Docker                           ║');
  console.error('║  - macOS: Install Apple Container and run: container system start ║');
  console.error('╚════════════════════════════════════════════════════════════════╝\n');
  throw new Error('Container runtime (Docker or Apple Container) is required');
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  const platformManager = getPlatformManager();

  // Register platforms
  platformManager.registerPlatform(new WhatsAppPlatform());
  platformManager.registerPlatform(new TelegramPlatform());
  platformManager.registerPlatform(new DiscordPlatform());

  // Start all platforms
  await platformManager.startAll();

  // Start scheduler
  startSchedulerLoop({
    sendMessage: (jid, text) => platformManager.sendMessage(jid, text),
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions
  });

  // Start IPC watcher
  startIpcWatcher();

  logger.info('NanoClaw started successfully');
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
