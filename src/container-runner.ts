/**
 * Container Runner for NanoClaw
 * Routes agent execution through model providers
 */

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR, DATA_DIR } from './config.js';
import { RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  ProviderFactory,
  getProviderManager,
  AgentRequest,
  AgentResponse
} from './model-providers/index.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Run an agent using the appropriate model provider for the group
 */
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput
): Promise<ContainerOutput> {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Get the appropriate provider for this group
  const providerManager = getProviderManager();
  const providerName = providerManager.getProviderForGroup(input.groupFolder);
  const provider = ProviderFactory.getProvider(providerName);

  logger.info({
    group: group.name,
    provider: providerName,
    isMain: input.isMain
  }, 'Routing to model provider');

  // Build the agent request
  const request: AgentRequest = {
    prompt: input.prompt,
    sessionId: input.sessionId,
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    isMain: input.isMain,
    isScheduledTask: input.isScheduledTask
  };

  // Execute via the provider
  const response: AgentResponse = await provider.runAgent(request, {
    group,
    logsDir
  });

  return response;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter(t => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(groupsFile, JSON.stringify({
    groups: visibleGroups,
    lastSync: new Date().toISOString()
  }, null, 2));
}
