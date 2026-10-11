'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function executable(configured = '') {
  if (configured.trim()) return configured.trim();
  const name = process.platform === 'win32' ? 'cswap.exe' : 'cswap';
  const local = path.join(os.homedir(), '.local', 'bin', name);
  return fs.existsSync(local) ? local : name;
}

function launchSpec(file, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { file, args };
  const home = options.home ?? os.homedir();
  const appData = options.appData ?? process.env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming');
  const toolDir = options.toolDir ?? process.env.UV_TOOL_DIR ?? path.win32.join(appData, 'uv', 'tools');
  const exists = options.exists ?? fs.existsSync;
  const envRoot = path.win32.join(toolDir, 'claude-swap');
  const scripts = path.win32.join(envRoot, 'Scripts');
  const knownLaunchers = [path.win32.join(home, '.local', 'bin', 'cswap.exe'), path.win32.join(scripts, 'cswap.exe')];
  const normalized = path.win32.normalize(file).toLowerCase();
  // Windows uv launchers can fail before Python starts. For the known uv
  // installation, run its supported module entry point using its own Python.
  // A custom executable outside this installation is always left untouched.
  if (!knownLaunchers.some(p => path.win32.normalize(p).toLowerCase() === normalized)) return { file, args };
  const python = path.win32.join(scripts, 'python.exe');
  const module = path.win32.join(envRoot, 'Lib', 'site-packages', 'claude_swap', '__main__.py');
  return exists(python) && exists(module) ? { file: python, args: ['-m', 'claude_swap', ...args] } : { file, args };
}

function run(file, args, allowedCodes = [0]) {
  const launch = launchSpec(file, args);
  return new Promise((resolve, reject) => {
    const child = execFile(launch.file, launch.args, {
      shell: false, windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      cwd: os.homedir(), env: { ...process.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' }
    }, (error, stdout, stderr) => {
      if (error && !allowedCodes.includes(error.code)) {
        if (error.code === 'ENOENT') return reject(new Error('cswap was not found. Set its executable path in Settings.'));
        if (error.killed) return reject(new Error('Claude Swap did not respond within 45 seconds. Try refreshing.'));
        // CLI messages can contain account labels; never forward its credential objects.
        return reject(new Error((stderr || stdout || error.message).trim().slice(0, 700)));
      }
      resolve(stdout.trim());
    });
    // Never let an interactive CLI prompt hang inside the extension host.
    child.stdin.end();
  });
}

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}
function windowData(value) {
  if (!value || typeof value !== 'object') return undefined;
  return { pct: percent(value.pct), resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : undefined };
}
function normalizeList(raw) {
  const data = JSON.parse(raw);
  if (data.error) throw new Error(String(data.error.message || 'Claude Swap could not load accounts.'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.accounts)) throw new Error('Unsupported cswap response. Update claude-swap and retry.');
  // Explicit whitelist: token material and unknown CLI fields never enter a webview.
  return data.accounts.filter(a => Number.isSafeInteger(a.number) && a.number > 0).map(a => ({
    number: a.number, email: String(a.email || ''), alias: String(a.alias || ''),
    active: a.active === true, disabled: a.disabled === true,
    usageStatus: String(a.usageStatus || 'unavailable'),
    fiveHour: windowData(a.usage?.fiveHour), sevenDay: windowData(a.usage?.sevenDay),
    fetchedAt: typeof a.usageFetchedAt === 'string' ? a.usageFetchedAt : undefined
  }));
}
function accountArgs(action, number) {
  if (!['switch', 'enable', 'disable'].includes(action) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid account action.');
  return action === 'switch' ? ['switch', String(number), '--json'] : [action, String(number)];
}
module.exports = { executable, run, normalizeList, accountArgs, percent, launchSpec };
