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
  DATA_DIR,
  GROUPS_DIR,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT
} from '../config.js';
import { RegisteredGroup } from '../types.js';
import { validateAdditionalMounts } from '../mount-security.js';
import { logger } from '../logger.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Container image for Gemini
const GEMINI_CONTAINER_IMAGE = process.env.GEMINI_CONTAINER_IMAGE || process.env.CONTAINER_IMAGE || 'nanoclaw-agent-gemini:latest';

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

  // Per-group IPC namespace
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false
  });

  // Environment file directory for Gemini auth
  // Directly mount the project .env file if it exists
  // This avoids creating copies and ensures consistency
  const envFile = path.join(process.cwd(), '.env');

  if (fs.existsSync(envFile)) {
    mounts.push({
      hostPath: envFile,
      containerPath: '/workspace/env-dir/env',
      readonly: true
    });
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

  args.push(GEMINI_CONTAINER_IMAGE);
  return args;
}

export class GeminiProvider extends BaseModelProvider {
  private runtime: 'docker' | 'container';

  constructor() {
    super();
    this.runtime = getContainerRuntime();
  }

  getName(): ModelProviderName {
    return 'gemini';
  }

  async runAgent(request: AgentRequest, context: ModelProviderContext): Promise<AgentResponse> {
    const startTime = Date.now();
    const { group, logsDir } = context;

    const mounts = buildVolumeMounts(group, request.isMain);
    const containerArgs = buildContainerArgs(mounts, this.runtime);

    logger.debug({
      group: group.name,
      provider: 'gemini',
      mounts: mounts.map(m => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`),
    }, 'Gemini container mount configuration');

    logger.info({
      group: group.name,
      provider: 'gemini',
      mountCount: mounts.length,
      isMain: request.isMain
    }, 'Spawning Gemini agent');

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
          if (line) logger.debug({ container: group.folder, provider: 'gemini' }, line);
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
        logger.error({ group: group.name, provider: 'gemini' }, 'Container timeout, killing');
        container.kill('SIGKILL');
        resolve({
          status: 'error',
          result: null,
          error: `Gemini container timed out after ${CONTAINER_TIMEOUT}ms`
        });
      }, group.containerConfig?.timeout || CONTAINER_TIMEOUT);

      container.on('close', (code) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        // Write log file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `gemini-${timestamp}.log`);
        const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

        const logLines = [
          `=== Gemini Container Run Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Provider: gemini`,
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
            `=== Stderr (last 4000 chars) ===`,
            stderr.slice(-4000)
          );
        }

        fs.writeFileSync(logFile, logLines.join('\n'));

        if (code !== 0) {
          logger.error({
            group: group.name,
            provider: 'gemini',
            code,
            duration,
            stderr: stderr.slice(-500)
          }, 'Gemini container exited with error');

          resolve({
            status: 'error',
            result: null,
            error: `Gemini container exited with code ${code}.\n\nLast stderr:\n${stderr.slice(-4000)}`
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
            // Fallback: try to find the last valid JSON object line
            const lines = stdout.trim().split('\n');
            jsonLine = lines[lines.length - 1];
          }

          const output = JSON.parse(jsonLine);

          // Map Gemini specific output format to AgentResponse if needed
          // The old provider expected { output: string, sessionId: string }
          // The new unified AgentResponse expects { status, result, error, newSessionId }

          // If the container returns the standardized format directly:
          if (output.status && (output.result !== undefined || output.error !== undefined)) {
            resolve(output as AgentResponse);
          } else {
            // Only if using an older image that returns the old format
            resolve({
              status: 'success',
              result: output.output || null,
              newSessionId: output.sessionId
            });
          }

          logger.info({
            group: group.name,
            provider: 'gemini',
            duration,
            status: 'success'
          }, 'Gemini agent completed');

        } catch (err) {
          logger.error({
            group: group.name,
            provider: 'gemini',
            stdout: stdout.slice(-500),
            error: err
          }, 'Failed to parse Gemini output');

          resolve({
            status: 'error',
            result: null,
            error: `Failed to parse Gemini output: ${err instanceof Error ? err.message : String(err)}`
          });
        }
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        logger.error({ group: group.name, provider: 'gemini', error: err }, 'Container spawn error');
        resolve({
          status: 'error',
          result: null,
          error: `Gemini container spawn error: ${err.message}`
        });
      });
    });
  }
}