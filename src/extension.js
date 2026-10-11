'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { AccountManager } = require('./backend');

function activate(context) {
  const views = new Set();
  let panel, accounts = [], busy = false, inFlight = false, error = '', notice = '', updatedAt, auto = false, disposed = false, lastPoll = 0;
  const config = () => vscode.workspace.getConfiguration('swapIsland');
  const manager = new AccountManager(context.secrets);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 110);
  status.command = 'swapIsland.sidebar';
  status.name = 'Claude Swap Island';
  context.subscriptions.push(status);
  function send() {
    if (disposed) return;
    const active = accounts.find(a => a.active);
    status.text = busy ? '$(sync~spin) Claude Island' : `$(account) Claude Island${auto ? ' $(zap)' : ''}`;
    status.tooltip = error || (active ? `${active.email}\n5-hour: ${active.fiveHour?.pct ?? '—'}% used · Weekly: ${active.sevenDay?.pct ?? '—'}% used\nOpen Claude Island` : 'Open Claude Island');
    status.show();
    const state = { accounts, busy, error, notice, updatedAt, auto, threshold: config().get('autoThreshold', 90) };
    for (const view of views) view.webview.postMessage({ type: 'state', state });
  }
  async function load() {
    accounts = await manager.list();
    updatedAt = new Date().toISOString();
    lastPoll = Date.now();
  }
  async function perform(action, silent = false) {
    if (inFlight || disposed) return;
    inFlight = true;
    if (!silent) { busy = true; error = ''; notice = ''; send(); }
    try { await action(); } catch (e) { error = e.message || 'Something went wrong.'; }
    finally { inFlight = false; busy = false; lastPoll = Date.now(); send(); }
  }
  const refresh = () => perform(load);
  const backgroundRefresh = () => perform(async () => { await load(); error = ''; }, true);
  async function accountAction(action, number) {
    if (!accounts.some(a => a.number === number)) return;
    await perform(async () => {
      if (action === 'switch') await manager.switchTo(number);
      else await manager.setDisabled(number, action === 'disable');
      await load();
      notice = action === 'switch' ? 'Account switched. Continue in Claude Code.' : action === 'disable' ? 'Account paused for auto-switching.' : 'Account included in auto-switching.';
    });
  }
  async function add() {
    await perform(async () => {
      await manager.saveCurrent();
      await load();
      notice = 'Current Claude login saved in encrypted VS Code storage. To add another, sign in to it in Claude Code, then save again.';
    });
  }
  async function autoTick() {
    if (!auto) return;
    await perform(async () => {
      const threshold = Math.max(1, Math.min(100, Math.round(config().get('autoThreshold', 90))));
      const switched = await manager.autoSwitch(threshold);
      await load();
      error = '';
      if (switched) notice = 'Auto-switch found an account with more room.';
    }, true);
  }
  async function receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') { send(); if (!updatedAt) await refresh(); return; }
    if (message.type === 'settings') { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:manep-local.claude-swap-island'); return; }
    if (message.type === 'expand') { expand(); return; }
    if (message.type === 'help') {
      await vscode.window.showInformationMessage('To add an account: sign in with it in Claude Code using /login, then click Save current login. Do not /logout first; that may revoke the previous login.'); return;
    }
    if (inFlight) return;
    if (message.type === 'refresh') await refresh();
    if (message.type === 'add') await add();
    if (['switch', 'enable', 'disable'].includes(message.type)) await accountAction(message.type, message.number);
    if (message.type === 'auto' && typeof message.enabled === 'boolean') {
      if (message.enabled && accounts.filter(a => !a.disabled).length < 2) { notice = 'Save at least two enabled accounts to use auto-switch.'; send(); return; }
      auto = message.enabled; notice = auto ? 'Auto-switch runs every minute while this VS Code window is open.' : 'Auto-switch is off.'; send();
      if (auto) await autoTick();
    }
  }
  function attach(view) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(18).toString('base64');
    let html = fs.readFileSync(vscode.Uri.joinPath(media, 'index.html').fsPath, 'utf8');
    html = html.replaceAll('{{csp}}', view.webview.cspSource).replaceAll('{{nonce}}', nonce)
      .replaceAll('{{css}}', view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'style.css')).toString())
      .replaceAll('{{js}}', view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')).toString());
    const receiver = view.webview.onDidReceiveMessage(m => { void receive(m); });
    views.add(view);
    view.onDidDispose(() => { views.delete(view); receiver.dispose(); });
    view.webview.html = html;
  }
  function expand() {
    if (panel) return panel.reveal();
    panel = vscode.window.createWebviewPanel('swapIsland.dashboard', 'Claude Island', vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    attach(panel);
    panel.onDidDispose(() => { panel = undefined; });
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('swapIsland.dock', { resolveWebviewView: attach }, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('swapIsland.accounts', { resolveWebviewView: attach }, { webviewOptions: { retainContextWhenHidden: true } }));
  const commands = {
    sidebar: () => vscode.commands.executeCommand('swapIsland.accounts.focus'),
    open: () => vscode.commands.executeCommand('swapIsland.dock.focus'), expand, refresh, add,
    switch: async () => {
      if (!updatedAt) await refresh();
      const chosen = await vscode.window.showQuickPick(accounts.map(a => ({ label: a.alias || a.email, description: a.active ? 'Current account' : `Account ${a.number}`, number: a.number })), { title: 'Switch Claude account' });
      if (chosen) await accountAction('switch', chosen.number);
    }
  };
  for (const [name, handler] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`swapIsland.${name}`, handler));
  const timer = setInterval(() => {
    if (inFlight) return;
    if (auto && Date.now() - lastPoll >= 60000) { lastPoll = Date.now(); void autoTick(); }
    else if (!auto && [...views].some(v => v.visible)) {
      const seconds = config().get('refreshSeconds', 180);
      if (seconds > 0 && Date.now() - lastPoll >= Math.max(60, seconds) * 1000) void backgroundRefresh();
    }
  }, 5000);
  context.subscriptions.push({ dispose() { disposed = true; auto = false; clearInterval(timer); panel?.dispose(); } });
  send(); void refresh();
  return { refresh, getState: () => ({ accounts, busy, error }) };
}
module.exports = { activate };
