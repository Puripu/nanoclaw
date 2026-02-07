import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { logger } from '../logger.js';
import { DATA_DIR, GROUPS_DIR, ASSISTANT_NAME } from '../config.js';
import axios from 'axios';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to get external IP
async function getExternalIp(): Promise<string> {
    try {
        const response = await axios.get('https://api.ipify.org?format=json', { timeout: 2000 });
        return response.data.ip;
    } catch (err) {
        return 'Unavailable';
    }
}

// Helper to check file existence and stats
function getFileStatus(filePath: string) {
    try {
        const stats = fs.statSync(filePath);
        return {
            exists: true,
            size: stats.size,
            modified: stats.mtime.toISOString()
        };
    } catch (err) {
        return { exists: false };
    }
}

// Helper to get approximate token count (very rough estimate based on file size/content)
// In a real scenario, you'd track this in the DB more accurately per conversation
function estimateTokens(filePath: string): number {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Rough estimate: 4 chars per token
        return Math.ceil(content.length / 4);
    } catch {
        return 0;
    }
}

export function startDashboard(port: number = 3000) {
    // Serve static files from public directory
    app.use(express.static(path.join(__dirname, 'public')));

    // API Endpoint for status
    app.get('/api/status', async (req, res) => {
        const memoryUsage = process.memoryUsage();
        const uptime = process.uptime();
        const externalIp = await getExternalIp();

        // Check key files
        const heartbeatFile = path.join(GROUPS_DIR, 'telegram', 'HEARTBEAT.md');
        const claudeFile = path.join(process.cwd(), 'CLAUDE.md');

        // Check Providers (Environment Variables)
        const providers = {
            gemini: !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY,
            claude: !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
            telegram: !!process.env.TELEGRAM_BOT_TOKEN
        };

        const status = {
            system: {
                uptime: uptime,
                memory: {
                    rss: memoryUsage.rss,
                    heapTotal: memoryUsage.heapTotal,
                    heapUsed: memoryUsage.heapUsed,
                    external: memoryUsage.external
                },
                ip: externalIp,
                platform: os.platform(),
                arch: os.arch(),
                loadavg: os.loadavg()
            },
            application: {
                assistantName: ASSISTANT_NAME,
                providers: providers,
                files: {
                    heartbeat: getFileStatus(heartbeatFile),
                    claudeMd: getFileStatus(claudeFile)
                }
            },
            timestamp: new Date().toISOString()
        };

        res.json(status);
    });

    app.listen(port, () => {
        logger.info({ port }, 'Dashboard server started');
    });
}
