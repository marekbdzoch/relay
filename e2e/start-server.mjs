// Starts a fresh Relay server for the e2e suite.
// Every run gets an empty data directory (e2e/.data/run-<timestamp>), so the
// first-run setup flow is always available and tests never see stale state.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dataRoot = path.join(root, 'e2e', '.data');

fs.rmSync(dataRoot, { recursive: true, force: true });
const dataDir = path.join(dataRoot, `run-${Date.now()}`);
fs.mkdirSync(path.join(dataRoot, 'auth'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server', 'src', 'index.ts')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.PORT ?? '3123',
    HOST: process.env.HOST ?? '0.0.0.0',
    DATA_DIR: dataDir,
    // built by the webServer command in playwright.config.ts
    WEB_DIST: path.join(root, 'e2e', '.web-dist'),
    UNFURL_LINKS: 'false',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    // keep the suite hermetic: no AI model, no Slack bridge, no external URL
    ANTHROPIC_API_KEY: '',
    SLACK_BOT_TOKEN: '',
    SLACK_APP_TOKEN: '',
    PUBLIC_URL: '',
    CORS_ORIGINS: '',
  },
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
