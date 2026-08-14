#!/usr/bin/env node
const { execSync, exec } = require('child_process');
const path = require('path');
const chokidar = require('chokidar');

// Configuration
const WATCH_PATH = process.env.WATCH_PATH || '.';
const REMOTE_NAME = process.env.REMOTE_NAME || 'garpsan';
const REMOTE_URL = process.env.REMOTE_URL || 'git@github.com:garpsan9090/android-backend-server.git';
const BRANCH = process.env.BRANCH || 'main';
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 2000);

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function remoteExists(name) {
  try {
    run(`git remote get-url ${name}`);
    return true;
  } catch (e) {
    return false;
  }
}

function ensureRemote() {
  if (!remoteExists(REMOTE_NAME)) {
    console.log(`Adding remote ${REMOTE_NAME} -> ${REMOTE_URL}`);
    run(`git remote add ${REMOTE_NAME} ${REMOTE_URL}`);
  }
}

function hasChanges() {
  const out = run('git status --porcelain');
  return out.length > 0;
}

function commitAndPush() {
  try {
    if (!hasChanges()) {
      console.log('No changes to commit.');
      return;
    }
    ensureRemote();
    run('git add -A');
    const ts = new Date().toISOString();
    const msg = `auto: update backend ${ts}`;
    try {
      run(`git commit -m "${msg}" --no-verify`);
    } catch (e) {
      console.log('Nothing to commit after staging (maybe only ignored files).');
      return;
    }
    console.log(`Pushing to ${REMOTE_NAME}/${BRANCH}...`);
    run(`git push ${REMOTE_NAME} ${BRANCH}`);
    console.log('Push completed.');
  } catch (err) {
    console.error('Failed to commit/push:', err.message || err);
  }
}

console.log('Starting backend auto-push watcher.');
console.log('WATCH_PATH=', WATCH_PATH);
console.log('REMOTE=', REMOTE_NAME, REMOTE_URL);

let timer = null;
const watcher = chokidar.watch(WATCH_PATH, {
  ignored: ['**/.git/**', '**/node_modules/**', '**/.env*', '**/uploads/**', '**/build/**'],
  ignoreInitial: true,
  persistent: true,
  cwd: path.resolve(__dirname, '..')
});

function schedulePush() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    commitAndPush();
    timer = null;
  }, DEBOUNCE_MS);
}

watcher.on('add', schedulePush);
watcher.on('change', schedulePush);
watcher.on('unlink', schedulePush);

process.on('SIGINT', () => {
  console.log('Stopping watcher...');
  watcher.close();
  process.exit(0);
});
