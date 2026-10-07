import { config } from './config.ts';
import { buildApp } from './app.ts';
import { startJobs } from './jobs.ts';
import { initSlackBridge } from './slack/bridge.ts';
import { initAgents } from './agents/runtime.ts';
import { io } from './realtime.ts';
import { get } from './db.ts';
import { initDemo } from './demo.ts';

const app = await buildApp();
await initDemo();
startJobs();
initSlackBridge();
initAgents();
await app.listen({ port: config.port, host: config.host });

// a brand-new instance: tell the person deploying it where to create the workspace
if (config.setupToken && !config.demo && !get('SELECT 1 FROM users LIMIT 1')) {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  app.log.info(`Relay is ready. Create your workspace at ${base}/setup?code=${config.setupToken}  (setup code: ${config.setupToken})`);
  console.log(`\n  ▶ Create your workspace: ${base}/setup?code=${config.setupToken}\n    Setup code: ${config.setupToken}\n`);
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${sig} received, shutting down`);
    // never hang on open connections: force exit after a short grace period
    setTimeout(() => process.exit(0), 3000).unref();
    io?.close();
    await app.close().catch(() => {});
    process.exit(0);
  });
}
