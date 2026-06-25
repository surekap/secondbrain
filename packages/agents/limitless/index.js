#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') });
const LifelogAgent = require('./agent');
const cron = require('node-cron');

let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
let _runId = null

console.log('🚀 LIMITLESS v2.0 - Agent-based Lifelog Processor');
console.log('🤖 Powered by Claude + MCP tools\n');

const agent = new LifelogAgent();

let _recordingsImported = 0
let _transcriptsProcessed = 0

async function fetchLifelogs() {
    if (telemetry && !_runId) {
        _runId = await telemetry.startRun({ agentId: 'limitless', workflowName: 'lifelog_processing' })
        _recordingsImported = 0
        _transcriptsProcessed = 0
    }
    try {
        console.log('📥 Fetching new lifelogs...');
        const { run } = require('./cron/fetchLifelogs');
        await run();
        console.log('✅ Lifelog fetch completed');
        _recordingsImported++
        if (telemetry && _runId) {
            telemetry.progress(_runId, 'recordings_imported', { completed: _recordingsImported })
        }
    } catch (error) {
        console.error('❌ Lifelog fetch failed:', error.message);
    }
}

console.log('⏰ Setting up production schedules:');
console.log('   📥 Fetch lifelogs: every 5 minutes');
console.log('   🤖 Process lifelogs: every 30 seconds\n');

cron.schedule('*/5 * * * *', fetchLifelogs);

cron.schedule('*/30 * * * * *', async () => {
    try {
        const processed = await agent.processBatch(5);
        _transcriptsProcessed += (processed || 0)
        if (telemetry && _runId) {
            telemetry.progress(_runId, 'transcripts_processed', { completed: _transcriptsProcessed })
        }
    } catch (error) {
        console.error('❌ Batch processing error:', error);
    }
});

async function ensureSchema() {
    const fs   = require('fs');
    const path = require('path');
    try {
        const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8');
        await agent.db.query(sql);
        console.log('✅ Schema ready');
    } catch (err) {
        console.error('❌ Schema setup error:', err.message);
    }
}

console.log('🏁 Starting initial fetch and process...\n');
ensureSchema().then(() => fetchLifelogs()).then(() => {
    setTimeout(async () => {
        const processed = await agent.processBatch(10);
        _transcriptsProcessed += (processed || 0)
        if (telemetry && _runId) {
            telemetry.progress(_runId, 'transcripts_processed', { completed: _transcriptsProcessed })
        }
    }, 2000);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Graceful shutdown initiated...');
    if (telemetry && _runId) {
        await telemetry.flush()
        await telemetry.endRun(_runId, { status: 'completed' })
    }
    try {
        if (agent.db && agent.db.end) {
            await agent.db.end();
            console.log('✅ Database connections closed');
        }
    } catch (error) {
        console.error('❌ Shutdown error:', error.message);
    }
    console.log('👋 Limitless Agent shutdown complete');
    process.exit(0);
});

console.log('\u2728 Limitless Agent v2.0 is running in production mode');
console.log('   Press Ctrl+C to stop\n');

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
