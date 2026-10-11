/* Account data is rendered only through textContent and validated numeric SVG attributes. */
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let state = { accounts: [], busy: true, auto: false }, collapsed = vscode.getState()?.collapsed === true;
  const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  let feedbackKey = '', feedbackTimer;
  function updateFeedback() {
    const message = state.error || state.notice || '';
    const key = message ? `${state.error ? 'error' : 'notice'}:${message}` : '';
    // Routine state updates must not restart the timeout or revive an old toast.
    if (key === feedbackKey) return;
    feedbackKey = key;
    clearTimeout(feedbackTimer);
    const toast = $('feedback');
    toast.textContent = message;
    toast.className = state.error ? 'error' : '';
    toast.hidden = !message;
    if (message) feedbackTimer = setTimeout(() => { toast.hidden = true; }, 5000);
  }
  function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function label(account) { return account.alias || account.email.split('@')[0] || `Account ${account.number}`; }
  function pct(value) { return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '—'; }
  function countdown(date) {
    const minutes = Math.ceil((Date.parse(date) - Date.now()) / 60000);
    if (!Number.isFinite(minutes)) return '';
    if (minutes <= 0) return 'reset due';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${minutes % 60}m`;
  }
  function usage(title, data, weekly) {
    const root = el('div', 'usage-item');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 44 44'); svg.setAttribute('class', `ring${weekly ? ' weekly' : ''}${data?.pct >= 90 ? ' high' : ''}`); svg.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 2; i++) { const c = document.createElementNS(svg.namespaceURI, 'circle'); c.setAttribute('cx', '22'); c.setAttribute('cy', '22'); c.setAttribute('r', '18'); if (i) { c.setAttribute('class', 'meter'); c.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(100, data?.pct || 0)) * 1.131} 113.1`); } svg.append(c); }
    const copy = el('div', 'usage-copy'); copy.append(el('strong', '', pct(data?.pct)), el('small', '', title)); root.append(svg, copy); return root;
  }
  const cards = new Map();
  function card(a) {
    const root = el('article', 'account');
    const top = el('div', 'account-top');
    const avatar = el('div', 'avatar'); avatar.setAttribute('aria-hidden', 'true');
    const title = el('div', 'account-title'); title.append(el('h3'), el('p'));
    top.append(avatar, title, el('span', 'tag'));
    const grid = el('div', 'usage-grid'); grid.append(usage('5-hour used', a.fiveHour, false), usage('Weekly used', a.sevenDay, true));
    const bottom = el('div', 'account-bottom'); bottom.append(el('button', 'switch-button'), el('button', 'pause-button'));
    root.append(top, grid, el('div', 'reset'), bottom);
    return root;
  }
  function updateCard(root, a) {
    const find = selector => root.querySelector(selector);
    const name = label(a);
    root.classList.toggle('active', !!a.active);
    root.setAttribute('aria-label', name + (a.active ? ', current account' : ''));
    find('.avatar').textContent = name.slice(0, 2).toUpperCase();
    find('h3').textContent = name; find('h3').title = name;
    find('.account-title p').textContent = a.email; find('.account-title p').title = a.email;
    const tag = find('.tag'); tag.hidden = !a.active && !a.disabled;
    tag.classList.toggle('paused', !!a.disabled); tag.textContent = a.disabled ? 'PAUSED' : 'CONNECTED';
    root.querySelectorAll('.usage-item').forEach((item, i) => {
      const data = i ? a.sevenDay : a.fiveHour;
      const value = Number.isFinite(data?.pct) ? Math.max(0, Math.min(100, data.pct)) : 0;
      item.querySelector('.ring').classList.toggle('high', value >= 90);
      item.querySelector('.meter').setAttribute('stroke-dasharray', value * 1.131 + ' 113.1');
      item.querySelector('strong').textContent = pct(data?.pct);
    });
    const reset = countdown(a.sevenDay?.resetsAt), age = (Date.now() - Date.parse(a.fetchedAt)) / 60000;
    const detail = root.children[2];
    const warning = !['ok', 'api_key', 'setup_token'].includes(a.usageStatus);
    detail.className = warning ? 'status-warning' : 'reset' + (age > 5 ? ' stale' : '');
    detail.textContent = warning ? 'Usage ' + (a.usageStatus || 'unavailable').replaceAll('_', ' ') + '. Refresh or sign in again in Claude Code.' : (reset ? 'Weekly ' + (reset === 'reset due' ? reset : 'resets in ' + reset) : 'Usage updates automatically') + (age > 5 ? ' · cached ' + Math.floor(age) + 'm ago' : '');
    const button = find('.switch-button'); button.textContent = a.active ? '✓  Current account' : 'Switch to account  ↗';
    button.disabled = state.busy || a.active; button.onclick = () => send('switch', { number: a.number });
    const pause = find('.pause-button'); pause.textContent = a.disabled ? '▷' : 'Ⅱ';
    pause.title = a.disabled ? 'Include in auto-switching' : 'Pause for auto-switching';
    pause.setAttribute('aria-label', pause.title + ': ' + name); pause.disabled = state.busy;
    pause.onclick = () => send(a.disabled ? 'enable' : 'disable', { number: a.number });
  }
  function updateAccounts() {
    const container = $('accounts'), numbers = new Set(state.accounts.map(a => a.number));
    for (const [number, root] of cards) if (!numbers.has(number)) { root.remove(); cards.delete(number); }
    container.querySelector('.loading-card')?.remove();
    state.accounts.forEach((a, index) => {
      let root = cards.get(a.number);
      if (!root) { root = card(a); cards.set(a.number, root); }
      updateCard(root, a);
      if (container.children[index] !== root) container.insertBefore(root, container.children[index] || null);
    });
    if (!state.updatedAt && state.busy && !state.accounts.length) container.append(el('div', 'loading-card'));
  }
  function setCollapsed() { document.body.classList.toggle('collapsed', collapsed); $('details').hidden = collapsed; $('collapse').textContent = collapsed ? '⌄' : '⌃'; $('collapse').setAttribute('aria-expanded', String(!collapsed)); $('collapse').setAttribute('aria-label', collapsed ? 'Expand account list' : 'Collapse account list'); }
  function render() {
    const active = state.accounts.find(a => a.active);
    document.body.classList.toggle('busy', state.busy);
    $('connection').textContent = state.busy ? 'SYNCING YOUR ISLAND' : state.error ? 'CONNECTION NEEDS ATTENTION' : active ? 'CONNECTED · CLAUDE CODE' : 'YOUR PERSONAL ACCOUNT DOCK';
    $('active-name').textContent = active ? label(active) : 'Your coding, uninterrupted.';
    $('active-detail').textContent = active ? active.email : 'All your Claude accounts. A little closer.';
    $('island-quota').textContent = pct(active?.fiveHour?.pct);
    $('account-count').textContent = state.accounts.length;
    updateFeedback();
    updateAccounts();
    $('empty').hidden = state.accounts.length > 0 || state.busy || !!state.error;
    for (const id of ['refresh', 'add', 'auto']) $(id).disabled = state.busy;
    $('auto').setAttribute('aria-checked', String(state.auto));
    $('threshold').textContent = `${state.threshold || 90}%`;
    $('auto-description').textContent = state.auto ? 'On · checks every minute in this window.' : 'Auto-switch before you hit your limit.';
    $('last-update').textContent = state.busy ? 'Syncing…' : state.updatedAt ? `Updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not connected';
  }
  for (const id of ['refresh', 'add', 'settings', 'expand', 'help']) $(id).onclick = () => send(id);
  $('auto').onclick = () => send('auto', { enabled: !state.auto });
  $('collapse').onclick = () => { collapsed = !collapsed; vscode.setState({ collapsed }); setCollapsed(); };
  window.addEventListener('message', event => { if (event.data?.type === 'state' && Array.isArray(event.data.state?.accounts)) { state = event.data.state; render(); } });
  setCollapsed(); render(); send('ready');
})();
