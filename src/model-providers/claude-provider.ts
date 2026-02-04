/**
 * Claude Model Provider for NanoClaw
 * Uses Claude Agent SDK via containerized execution
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  BaseModelProvider,
  AgentRequest,
  AgentResponse,
  ModelProviderContext,
  ModelProviderName
} from './types.js';
import {
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  DATA_DIR,
  GROUPS_DIR
} from '../config.js';
import { RegisteredGroup } from '../types.js';
import { validateAdditionalMounts } from '../mount-security.js';
import { logger } from '../logger.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Container image for Claude
const CLAUDE_CONTAINER_IMAGE = process.env.CLAUDE_CONTAINER_IMAGE || process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

function getContainerRuntime(): 'docker' | 'container' {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return 'docker';
  } catch {
    try {
      execSync('/usr/bin/docker info', { stdio: 'ignore', timeout: 5000 });
      return 'docker';
    } catch {
      // Continue to check Apple Container
    }
  }

  if (process.platform === 'darwin') {
    try {
      execSync('container system status', { stdio: 'ignore' });
      return 'container';
    } catch {
      // Not available
    }
  }

  try {
    execSync('which docker', { stdio: 'ignore' });
    return 'docker';
  } catch {
    return 'docker';
  }
}

function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false
    });
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });
  } else {
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true
      });
    }
  }

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false
  });

  // Per-group IPC namespace
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false
  });

  // Environment file directory for Claude auth
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const allowedVars = [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_EULA_ACCEPTED',
      'CLAUDE_CODE_SKIP_PERMISSION_CHECKS'
    ];
    const filteredLines = envContent
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        return allowedVars.some(v => trimmed.startsWith(`${v}=`));
      });

    if (filteredLines.length > 0) {
      fs.writeFileSync(path.join(envDir, 'env'), filteredLines.join('\n') + '\n');
      mounts.push({
        hostPath: envDir,
        containerPath: '/workspace/env-dir',
        readonly: true
      });
    }
  }

  // Additional mounts from config
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(mounts: VolumeMount[], runtime: 'docker' | 'container'): string[] {
  const args: string[] = ['run', '-i', '--rm'];

  if (runtime === 'docker') {
    for (const mount of mounts) {
      if (mount.readonly) {
        args.push('--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`);
      } else {
        args.push('--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath}`);
      }
    }
  } else {
    for (const mount of mounts) {
      if (mount.readonly) {
        args.push('--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`);
      } else {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      }
    }
  }

  args.push(CLAUDE_CONTAINER_IMAGE);
  return args;
}

export class ClaudeProvider extends BaseModelProvider {
  private runtime: 'docker' | 'container';

  constructor() {
    super();
    this.runtime = getContainerRuntime();
  }

  getName(): ModelProviderName {
    return 'claude';
  }

  async runAgent(request: AgentRequest, context: ModelProviderContext): Promise<AgentResponse> {
    const startTime = Date.now();
    const { group, logsDir } = context;

    const mounts = buildVolumeMounts(group, request.isMain);
    const containerArgs = buildContainerArgs(mounts, this.runtime);

    logger.debug({
      group: group.name,
      provider: 'claude',
      mounts: mounts.map(m => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`),
    }, 'Claude container mount configuration');

    logger.info({
      group: group.name,
      provider: 'claude',
      mountCount: mounts.length,
      isMain: request.isMain
    }, 'Spawning Claude agent');

    return new Promise((resolve) => {
      const container = spawn(this.runtime, containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;

      // Send input to container
      const containerInput = {
        prompt: request.prompt,
        sessionId: request.sessionId,
        groupFolder: request.groupFolder,
        chatJid: request.chatJid,
        isMain: request.isMain,
        isScheduledTask: request.isScheduledTask
      };
      container.stdin.write(JSON.stringify(containerInput));
      container.stdin.end();

      container.stdout.on('data', (data) => {
        if (stdoutTruncated) return;
        const chunk = data.toString();
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn({ group: group.name, size: stdout.length }, 'Container stdout truncated');
        } else {
          stdout += chunk;
        }
      });

      container.stderr.on('data', (data) => {
        const chunk = data.toString();
        const lines = chunk.trim().split('\n');
        for (const line of lines) {
          if (line) logger.debug({ container: group.folder, provider: 'claude' }, line);
        }
        if (stderrTruncated) return;
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
        } else {
          stderr += chunk;
        }
      });

      const timeout = setTimeout(() => {
        logger.error({ group: group.name, provider: 'claude' }, 'Container timeout, killing');
        container.kill('SIGKILL');
        resolve({
          status: 'error',
          result: null,
          error: `Claude container timed out after ${CONTAINER_TIMEOUT}ms`
        });
      }, group.containerConfig?.timeout || CONTAINER_TIMEOUT);

      container.on('close', (code) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        // Write log file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `claude-${timestamp}.log`);
        const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

        const logLines = [
          `=== Claude Container Run Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Provider: claude`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          ``
        ];

        if (isVerbose) {
          logLines.push(
            `=== Stderr ===`,
            stderr,
            ``,
            `=== Stdout ===`,
            stdout
          );
        } else if (code !== 0) {
          logLines.push(
            `=== Stderr (last 500 chars) ===`,
            stderr.slice(-500)
          );
        }

        fs.writeFileSync(logFile, logLines.join('\n'));

        if (code !== 0) {
          logger.error({
            group: group.name,
            provider: 'claude',
            code,
            duration,
            stderr: stderr.slice(-500)
          }, 'Claude container exited with error');

          resolve({
            status: 'error',
            result: null,
            error: `Claude container exited with code ${code}.\n\nLast stderr:\n${stderr.slice(-1000)}`
          });
          return;
        }

        try {
          // Extract JSON between sentinel markers
          const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
          const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

          let jsonLine: string;
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            jsonLine = stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
          } else {
            const lines = stdout.trim().split('\n');
            jsonLine = lines[lines.length - 1];
          }

          const output: AgentResponse = JSON.parse(jsonLine);

          logger.info({
            group: group.name,
            provider: 'claude',
            duration,
            status: output.status,
            hasResult: !!output.result
          }, 'Claude agent completed');

          resolve(output);
        } catch (err) {
          logger.error({
            group: group.name,
            provider: 'claude',
            stdout: stdout.slice(-500),
            error: err
          }, 'Failed to parse Claude output');

          resolve({
            status: 'error',
            result: null,
            error: `Failed to parse Claude output: ${err instanceof Error ? err.message : String(err)}`
          });
        }
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        logger.error({ group: group.name, provider: 'claude', error: err }, 'Container spawn error');
        resolve({
          status: 'error',
          result: null,
          error: `Claude container spawn error: ${err.message}`
        });
      });
    });
  }
}
