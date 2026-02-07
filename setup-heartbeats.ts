
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { initDatabase, createTask, getAllTasks, deleteTask } from './src/db.js';
import { DATA_DIR, GROUPS_DIR, SCHEDULER_POLL_INTERVAL } from './src/config.js';
import { CronExpressionParser } from 'cron-parser';

// Initialize DB connection
initDatabase();

// Define targets
const targets = [
    {
        name: 'Telegram',
        groupFolder: 'telegram',
        chatJid: 'telegram@bot', // Static JID for Telegram bot
        interval: '*/30 * * * *' // Every 30 mins
    },
    {
        name: 'Discord',
        groupFolder: 'discord',
        chatJid: 'discord-1468469238787211325', // Found in traces
        interval: '*/30 * * * *'
    },
    {
        name: 'Main (WhatsApp)',
        groupFolder: 'main',
        chatJid: '818011448758@s.whatsapp.net', // From registered_groups.json
        interval: '*/30 * * * *'
    }
];

const HEARTBEAT_TEMPLATE = `# Heartbeat Configuration

## Purpose
This file tracks tasks, reminders, and monitoring items that should be checked during periodic heartbeat runs.

## How It Works
- Every 30 minutes, I'll check this file and my workspace
- If something needs attention, I'll send you a message
- If everything is OK, I stay silent

## Active Monitors

### Reminders
<!-- Add time-based reminders here -->
- None currently

### Recurring Checks
<!-- Add things to monitor periodically -->
- None currently

### Scheduled Tasks
<!-- Track upcoming tasks or deadlines -->
- None currently

## Notes
- You can add items to any section above
- Use clear language about when/what needs attention
- I'll clean up completed items during heartbeats

---
*Last heartbeat: Not yet started*
`;

async function setup() {
    const existingTasks = getAllTasks();

    for (const target of targets) {
        console.log(`Setting up Heartbeat for ${target.name}...`);

        // 1. Ensure Folder & File Exist
        const groupDir = path.join(GROUPS_DIR, target.groupFolder);
        if (!fs.existsSync(groupDir)) {
            console.log(`  Creating group folder: ${groupDir}`);
            fs.mkdirSync(groupDir, { recursive: true });
        }

        const heartbeatFile = path.join(groupDir, 'HEARTBEAT.md');
        if (!fs.existsSync(heartbeatFile)) {
            console.log(`  Creating HEARTBEAT.md: ${heartbeatFile}`);
            fs.writeFileSync(heartbeatFile, HEARTBEAT_TEMPLATE);
        } else {
            console.log(`  HEARTBEAT.md already exists.`);
        }

        // 2. Check for existing Heartbeat Task
        const existingTask = existingTasks.find(t =>
            t.group_folder === target.groupFolder &&
            t.prompt.includes('Read HEARTBEAT.md')
        );

        if (existingTask) {
            console.log(`  Heartbeat task already exists (ID: ${existingTask.id}). Updating to PAUSED.`);
            const { updateTask } = await import('./src/db.js');
            updateTask(existingTask.id, { status: 'paused' });
        } else {
            console.log(`  Creating new Heartbeat task (Dormant)...`);

            const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

            // Calculate next run
            const interval = CronExpressionParser.parse(target.interval);
            const nextRun = interval.next().toISOString();

            createTask({
                id: taskId,
                group_folder: target.groupFolder,
                chat_jid: target.chatJid,
                prompt: `Read HEARTBEAT.md. Check for items in 'Scheduled Tasks', 'Reminders', or 'Recurring Checks'. If anything is due or needs attention, notify me. Otherwise, update the '*Last heartbeat*' line at the bottom of the file with the current timestamp and stay silent.`,
                schedule_type: 'cron',
                schedule_value: target.interval,
                context_mode: 'group', // Important: use group context
                next_run: nextRun,
                status: 'paused', // Dormant by default
                created_at: new Date().toISOString()
            });

            console.log(`  Task created: ${taskId} (PAUSED)`);
        }
    }
}

console.log('Heartbeat setup complete.');

setup().catch(console.error);
