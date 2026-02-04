import path from 'path';
import { DATA_DIR } from './config.js';
import { loadJson, saveJson } from './utils.js';
import { RegisteredGroup, Session } from './types.js';
import { logger } from './logger.js';
import fs from 'fs';

// State variables
export let sessions: Session = {};
export let registeredGroups: Record<string, RegisteredGroup> = {};
export let lastAgentTimestamp: Record<string, string> = {};

// Helper to access state
export const getState = () => ({
  sessions,
  registeredGroups,
  lastAgentTimestamp
});

export function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string; last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

export function saveState(): void {
  // Note: lastTimestamp is managed by the caller (WhatsApp loop) usually, but here we only save what we manage
  // If we need to save lastTimestamp, we should pass it or manage it elsewhere.
  // For now, preserving existing structure where router_state.json holds last_agent_timestamp
  const statePath = path.join(DATA_DIR, 'router_state.json');
  // We read existing to preserve last_timestamp if it exists
  const existing = loadJson<any>(statePath, {});

  saveJson(statePath, {
    ...existing,
    last_agent_timestamp: lastAgentTimestamp
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);
}

export function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

export function updateSession(groupFolder: string, sessionId: string): void {
  sessions[groupFolder] = sessionId;
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

export function updateLastAgentTimestamp(jid: string, timestamp: string): void {
  lastAgentTimestamp[jid] = timestamp;
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const existing = loadJson<any>(statePath, {});
  saveJson(statePath, { ...existing, last_agent_timestamp: lastAgentTimestamp });
}
