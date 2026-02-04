import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import {
  DATA_DIR,
  GROUPS_DIR,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE
} from './config.js';
import { RegisteredGroup } from './types.js';
import { validateAdditionalMounts } from './mount-security.js';
import { logger } from './logger.js';
import { AgentResponse } from './model-providers/types.js';

// Sentinel markers for robust output parsing
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export interface ContainerExecutionOptions {
  runtime: 'docker' | 'container';
  containerImage: string;
  mounts: VolumeMount[];
  input: any;
  logPrefix: string;
  logsDir: string;
}

export function getContainerRuntime(): 'docker' | 'container' {
  // 1. Check for Docker (preferred)
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return 'docker';
  } catch (err) {
    // Try full path as fallback
    try {
      execSync('/usr/bin/docker info', { stdio: 'ignore', timeout: 5000 });
      return 'docker';
    } catch {
      // Docker daemon might not be running yet
    }
  }

  // 2. Check for Apple Container (macOS only)
  if (process.platform === 'darwin') {
    try {
      execSync('container system status', { stdio: 'ignore' });
      return 'container';
    } catch {
      // Apple Container not available or not running
    }
  }

  // 3. Last resort: check if docker binary exists even if daemon check failed
  try {
    execSync('which docker', { stdio: 'ignore' });
    return 'docker';
  } catch {
    // No runtime found, defaulting to docker for better error messages
    return 'docker';
  }
}

export function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });

    // Global memory directory (read-only for non-main)
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

  // Environment file directory
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });

  // Create .env file content from process.env or file
  const envMap = new Map<string, string>();
  const envFile = path.join(projectRoot, '.env');

  const allowedVars = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_EULA_ACCEPTED',
    'CLAUDE_CODE_SKIP_PERMISSION_CHECKS',
    // Added for Gemini
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY'
  ];

  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const [key, ...parts] = trimmed.split('=');
      const val = parts.join('=');
      if (allowedVars.includes(key) && val) {
        envMap.set(key, val);
      }
    });
  }

  // Process.env overrides
  for (const v of allowedVars) {
    if (process.env[v]) {
      envMap.set(v, process.env[v]!);
    }
  }

  if (envMap.size > 0) {
    const envContent = Array.from(envMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';

    fs.writeFileSync(path.join(envDir, 'env'), envContent);
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
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

export function buildContainerArgs(
  mounts: VolumeMount[],
  containerImage: string,
  runtime: 'docker' | 'container'
): string[] {
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
    // Apple Container
    for (const mount of mounts) {
      if (mount.readonly) {
        args.push('--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`);
      } else {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      }
    }
  }

  args.push(containerImage);
  return args;
}

export async function spawnContainerAgent(
  options: ContainerExecutionOptions
): Promise<AgentResponse> {
  const { runtime, containerImage, mounts, input, logPrefix, logsDir } = options;
  const containerArgs = buildContainerArgs(mounts, containerImage, runtime);

  // Ensure logs directory exists
  fs.mkdirSync(logsDir, { recursive: true });

  const startTime = Date.now();
  const groupName = input.groupFolder || 'unknown';

  return new Promise((resolve) => {
    const container = spawn(runtime, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Send input to container
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on('data', (data) => {
      if (stdoutTruncated) return;
      const chunk = data.toString();
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        logger.warn({ group: groupName, size: stdout.length }, 'Container stdout truncated');
      } else {
        stdout += chunk;
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: groupName, provider: logPrefix }, line);
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

    // Timeout handling
    // Allow per-group timeout override or use default
    const timeoutMs = options.input.containerConfig?.timeout || CONTAINER_TIMEOUT;

    const timeout = setTimeout(() => {
      logger.error({ group: groupName, provider: logPrefix }, 'Container timeout, killing');
      container.kill('SIGKILL');
      resolve({
        status: 'error',
        result: null,
        error: `Container timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Write log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `${logPrefix}-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${groupName}`,
        `Provider: ${logPrefix}`,
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
          group: groupName,
          provider: logPrefix,
          code,
          duration,
          stderr: stderr.slice(-500)
        }, 'Container exited with error');

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}.\n\nLast stderr:\n${stderr.slice(-1000)}`
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
          group: groupName,
          provider: logPrefix,
          duration,
          status: output.status,
          hasResult: !!output.result
        }, 'Container completed');

        resolve(output);
      } catch (err) {
        logger.error({
          group: groupName,
          provider: logPrefix,
          stdout: stdout.slice(-500),
          error: err
        }, 'Failed to parse container output');

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: groupName, provider: logPrefix, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`
      });
    });
  });
}
