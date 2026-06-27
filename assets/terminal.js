/* ═══════════════════════════════════════════
   TermAI — Terminal Core v2
   Clean Architecture Edition
   ═══════════════════════════════════════════ */

// ─── State ───────────────────────────────────
const state = {
  tabs:          [],
  activeTab:     null,
  tabCounter:    0,
  isSleeping:    false,
  sleepTimer:    null,
  fontsize:      parseInt(localStorage.getItem('termai_fontsize')) || 14,
  theme:         localStorage.getItem('termai_theme') || 'dark',
  cmdHistory:    JSON.parse(localStorage.getItem('termai_hist') || '[]'),
  historyIndex:  -1,
  currentInput:  '',
  sessionId:     'session_' + Date.now(),
};

// ─── Callback registries ─────────────────────
window.terminalCallbacks = {};  // command-done callbacks
window.onShellChunk = null;     // set below — streaming output handler

// ─── Android bridge helpers ───────────────────
const Terminal = () => window.Terminal || null;
const Billing  = () => window.Billing  || null;
const isNative = () => !!window.Terminal;

// ─── Shell chunk handler (streaming) ─────────
window.onShellChunk = function(sessionId, chunk) {
  if (sessionId !== state.sessionId) return;
  const tab = getActiveTab();
  if (tab) tab.term.write(chunk);
};

// ─── Tab Management ───────────────────────────
function createTab(label) {
  const id   = ++state.tabCounter;
  const name = label || `Shell ${id}`;

  const term       = new Terminal({ fontFamily: "'JetBrains Mono', monospace",
    fontSize: state.fontsize, theme: getXtermTheme(),
    cursorBlink: true,
    cursorStyle: localStorage.getItem('termai_cursor') || 'block',
    scrollback: parseInt(localStorage.getItem('termai_scrollback')) || 5000,
    allowTransparency: true });

  const fitAddon      = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  const tab = { id, name, term, fitAddon,
                inputBuffer: '', isRunning: false, currentCallbackId: null };
  state.tabs.push(tab);

  renderTabs();
  switchTab(id);

  term.open(document.getElementById('terminal'));
  setTimeout(() => { fitAddon.fit(); term.focus(); }, 50);

  new ResizeObserver(() => { try { fitAddon.fit(); } catch {} })
    .observe(document.getElementById('terminal-container'));

  setupInput(tab);
  printWelcome(tab);
  showPrompt(tab);
  return tab;
}

function addTab()       { createTab(); }
function getTab(id)     { return state.tabs.find(t => t.id === id); }
function getActiveTab() { return getTab(state.activeTab); }

function switchTab(id) {
  document.getElementById('terminal').innerHTML = '';
  state.activeTab = id;
  const tab = getTab(id);
  if (!tab) return;
  tab.term.open(document.getElementById('terminal'));
  setTimeout(() => { tab.fitAddon.fit(); tab.term.focus(); }, 50);
  renderTabs();
}

function closeTab(id, e) {
  if (e) e.stopPropagation();
  if (state.tabs.length === 1) return;
  const idx = state.tabs.findIndex(t => t.id === id);
  state.tabs.splice(idx, 1);
  if (state.activeTab === id)
    switchTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
  renderTabs();
}

function renderTabs() {
  document.getElementById('tabs-list').innerHTML = state.tabs.map(t => `
    <div class="tab-item ${t.id === state.activeTab ? 'active' : ''}" onclick="switchTab(${t.id})">
      <span>⬛ ${t.name}</span>
      ${state.tabs.length > 1
        ? `<span class="tab-close" onclick="closeTab(${t.id},event)">✕</span>`
        : ''}
    </div>`).join('');
}

// ─── Input ────────────────────────────────────
function setupInput(tab) {
  tab.term.onKey(({ key, domEvent }) => {
    if (state.isSleeping) { wakeUp(); return; }

    if (tab.isRunning) {
      // Forward raw input to shell (Ctrl+C etc.)
      if (isNative()) Terminal().writeStdin(key);
      return;
    }

    const code = domEvent.keyCode;
    if (code === 13)                              handleEnter(tab);
    else if (code === 8 && tab.inputBuffer.length) { tab.inputBuffer = tab.inputBuffer.slice(0,-1); tab.term.write('\b \b'); }
    else if (code === 9)                          handleTabComplete(tab);
    else if (code === 38)                         navigateHistory(tab, -1);
    else if (code === 40)                         navigateHistory(tab, 1);
    else if (domEvent.ctrlKey)                    handleCtrl(tab, domEvent.key.toLowerCase());
    else if (key.length === 1 && !domEvent.ctrlKey && !domEvent.metaKey)
      { tab.inputBuffer += key; tab.term.write(key); }
  });
}

async function handleEnter(tab) {
  const cmd = tab.inputBuffer.trim();
  tab.term.write('\r\n');
  tab.inputBuffer = '';
  state.historyIndex = -1;

  if (!cmd) { showPrompt(tab); return; }

  saveHistory(cmd);

  // ── AI built-in commands ──
  if (await handleBuiltins(tab, cmd)) return;

  // ── Security scan ──
  if (isNative()) {
    const scanRaw = Terminal().securityScan(cmd);
    const scan    = JSON.parse(scanRaw || '{"safe":true}');

    if (scan.blocked) {
      showSecurityBlocked(tab, scan);
      return;
    }
    if (!scan.safe && scan.risk !== 'LOW') {
      showSecurityWarning(tab, cmd, scan);
      return;
    }
  }

  executeCommand(tab, cmd);
}

// ─── Execute ──────────────────────────────────
function executeCommand(tab, cmd) {
  tab.isRunning = true;
  updatePwdDisplay();

  if (isNative()) {
    const callbackId = `cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    tab.currentCallbackId = callbackId;

    window.terminalCallbacks[callbackId] = (result) => {
      delete window.terminalCallbacks[callbackId];
      tab.currentCallbackId = null;
      tab.isRunning = false;

      try {
        const r = typeof result === 'string' ? JSON.parse(result) : result;
        updatePwdDisplay(r.cwd);

        // Auto AI error analysis
        if (r.exitCode !== 0 && AI.autoAnalyze && AI.isPremium) {
          analyzeLastError(tab, cmd, r.exitCode);
        }
      } catch(e) {}

      showPrompt(tab);
    };

    Terminal().executeCommand(cmd, state.sessionId, callbackId);

  } else {
    // Browser demo mode
    simulateDemoCommand(tab, cmd);
  }
}

// ─── Builtins ─────────────────────────────────
async function handleBuiltins(tab, cmd) {
  if (cmd === 'clear' || cmd === 'cls') { tab.term.clear(); showPrompt(tab); return true; }
  if (cmd === 'exit')  { tab.term.writeln('\x1b[33mSession closed.\x1b[0m'); return true; }
  if (cmd === '!help') { printAIHelp(tab); return true; }

  if (cmd.startsWith('!ai ') || cmd === '!ai') {
    const q = cmd.replace(/^!ai\s*/i,'').trim();
    if (q) await runAIChat(tab, q);
    return true;
  }
  if (cmd.startsWith('!explain')) {
    const target = cmd.replace('!explain','').trim() || getLastCmd();
    if (target) await showAIExplain(tab, target);
    return true;
  }
  if (cmd.startsWith('!gen ')) {
    await showAIGenerate(tab, cmd.replace('!gen ',''));
    return true;
  }
  return false;
}

// ─── Security UI ──────────────────────────────
function showSecurityBlocked(tab, scan) {
  tab.term.writeln(`\r\n\x1b[31m⛔ BLOCKED: ${scan.reason}\x1b[0m`);
  tab.term.writeln(`\x1b[2m${scan.detail}\x1b[0m`);
  showPrompt(tab);
}

function showSecurityWarning(tab, cmd, scan) {
  const riskColor = scan.risk === 'HIGH' ? '\x1b[31m' : '\x1b[33m';
  tab.term.writeln(`\r\n${riskColor}⚠️  ${scan.risk}: ${scan.reason}\x1b[0m`);
  tab.term.writeln(`\x1b[2m${scan.detail}\x1b[0m`);
  tab.term.writeln('\x1b[2mType \x1b[0m\x1b[33m!proceed\x1b[0m\x1b[2m to run anyway, or press Enter to cancel.\x1b[0m');

  // Temporarily capture next input
  const originalHandler = tab.term.onKey;
  tab.inputBuffer = '';
  tab.term.write('\r\n');
  showPrompt(tab, false);

  // Store pending command for !proceed
  tab._pendingCmd = cmd;
  tab._awaitingProceed = true;
  tab.term.write('');
}

// ─── AI Features ─────────────────────────────
async function analyzeLastError(tab, cmd, exitCode) {
  try {
    showAIPanel({ loading: true, label: '🔴 Error Analysis' });
    const result = await AI.analyzeError(cmd, '', exitCode);
    const fixCmd = AI.extractFixCommand(result);
    showAIPanel({
      loading: false, label: '🔴 Error Analysis', content: result,
      actions: fixCmd
        ? [{ label: '⚡ Apply Fix', primary: true, onclick: `applyFix(${JSON.stringify(fixCmd)})` },
           { label: 'Dismiss', onclick: 'closeAIPanel()' }]
        : [{ label: 'Dismiss', onclick: 'closeAIPanel()' }]
    });
  } catch(e) { handleAIError(e); }
}

async function showAIExplain(tab, cmd) {
  showAIPanel({ loading: true, label: `📖 Explain` });
  try {
    const r = await AI.explainCommand(cmd);
    showAIPanel({ loading: false, label: `📖 ${cmd}`, content: r,
      actions: [{ label: 'Close', onclick: 'closeAIPanel()' }] });
  } catch(e) { handleAIError(e); }
}

async function showAIGenerate(tab, desc) {
  showAIPanel({ loading: true, label: '📜 Generating...' });
  try {
    const r = await AI.generateScript(desc);
    showAIPanel({ loading: false, label: '📜 Generated Script', content: r,
      actions: [
        { label: '▶ Run', primary: true, onclick: `runScript(${JSON.stringify(r)})` },
        { label: 'Copy', onclick: `copyText(${JSON.stringify(r)})` },
        { label: 'Close', onclick: 'closeAIPanel()' }
      ]});
  } catch(e) { handleAIError(e); }
}

async function runAIChat(tab, message) {
  showAIPanel({ loading: true, label: '🤖 TermAI' });
  try {
    const r = await AI.chat(message);
    const fix = AI.extractFixCommand(r);
    showAIPanel({ loading: false, label: '🤖 TermAI', content: r,
      actions: fix
        ? [{ label: '▶ Run', primary: true, onclick: `applyFix(${JSON.stringify(fix)})` },
           { label: 'Close', onclick: 'closeAIPanel()' }]
        : [{ label: 'Close', onclick: 'closeAIPanel()' }]
    });
  } catch(e) { handleAIError(e); }
}

function quickAI() {
  const tab = getActiveTab();
  const current = tab?.inputBuffer?.trim();
  if (current) showAIExplain(tab, current);
  else {
    const q = prompt('Ask TermAI:');
    if (q) runAIChat(tab, q);
  }
}

function applyFix(cmd) {
  closeAIPanel();
  const tab = getActiveTab();
  if (!tab || !cmd) return;
  tab.term.write('\r\n');
  tab.inputBuffer = cmd;
  tab.term.write(cmd);
  handleEnter(tab);
}

function runScript(script) {
  closeAIPanel();
  const tab = getActiveTab();
  if (!tab) return;
  // Write to tmp and execute
  const cmds = [
    `cat > /tmp/termai_gen.sh << 'EOF'\n${script}\nEOF`,
    'chmod +x /tmp/termai_gen.sh && bash /tmp/termai_gen.sh'
  ];
  let i = 0;
  const runNext = () => {
    if (i >= cmds.length) return;
    tab.inputBuffer = cmds[i++];
    handleEnter(tab);
    setTimeout(runNext, 500);
  };
  runNext();
}

// ─── AI Panel ─────────────────────────────────
function showAIPanel({ loading, label, content, actions }) {
  const panel = document.getElementById('ai-panel');
  panel.classList.remove('hidden');
  document.getElementById('ai-panel-label').textContent = label || 'TermAI';

  const contentEl = document.getElementById('ai-content');
  contentEl.innerHTML = loading
    ? `<div class="ai-loading"><div class="spinner"></div><span>Processing...</span></div>`
    : formatAIContent(content || '');

  const actEl = document.getElementById('ai-actions');
  actEl.innerHTML = (actions || []).map(a =>
    `<button class="ai-action-btn ${a.primary?'primary':''}" onclick="${a.onclick}">${a.label}</button>`
  ).join('');
}

function formatAIContent(text) {
  return `<div class="ai-section">${
    text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/`([^`\n]+)`/g,'<span class="ai-code" style="display:inline;padding:1px 5px;border-radius:3px">$1</span>')
        .replace(/\[([A-Z]+)\]/g,'<span style="color:var(--ai-color);font-weight:700">[$1]</span>')
        .replace(/\n/g,'<br>')
  }</div>`;
}

function closeAIPanel() {
  document.getElementById('ai-panel').classList.add('hidden');
}

function handleAIError(e) {
  const msg = e.message === 'NOT_PREMIUM' ? 'Upgrade to Premium to use AI features.'
            : e.message === 'NO_ENDPOINT'  ? 'Set your API endpoint in Settings.'
            : `Error: ${e.message}`;
  showAIPanel({ loading: false, label: '⚠️ AI Error', content: msg,
    actions: [
      e.message === 'NOT_PREMIUM'
        ? { label: '💎 Upgrade', primary: true, onclick: 'upgradeToPremium()' }
        : { label: 'Settings', primary: true, onclick: 'openSettings()' },
      { label: 'Close', onclick: 'closeAIPanel()' }
    ]});
}

// ─── Autocomplete ─────────────────────────────
async function handleTabComplete(tab) {
  if (!tab.inputBuffer || !AI.isPremium) return;
  try {
    const suggestions = await AI.autocomplete(tab.inputBuffer, state.cmdHistory.slice(-10));
    if (!suggestions.length) return;
    if (suggestions.length === 1) {
      const add = suggestions[0].slice(tab.inputBuffer.length);
      tab.inputBuffer = suggestions[0];
      tab.term.write(add);
    } else {
      tab.term.writeln('\r\n\x1b[2m' + suggestions.join('  ') + '\x1b[0m');
      showPrompt(tab, false);
      tab.term.write(tab.inputBuffer);
    }
  } catch {}
}

// ─── History ──────────────────────────────────
function navigateHistory(tab, dir) {
  const hist = state.cmdHistory;
  if (!hist.length) return;
  tab.term.write('\r\x1b[K');
  showPrompt(tab, false);
  if (state.historyIndex === -1 && dir === -1) {
    state.currentInput = tab.inputBuffer;
    state.historyIndex = hist.length - 1;
  } else {
    state.historyIndex = Math.max(0, Math.min(hist.length-1, state.historyIndex + dir));
  }
  tab.inputBuffer = hist[state.historyIndex] || state.currentInput;
  tab.term.write(tab.inputBuffer);
}

function saveHistory(cmd) {
  if (state.cmdHistory[state.cmdHistory.length-1] === cmd) return;
  state.cmdHistory.push(cmd);
  if (state.cmdHistory.length > 500) state.cmdHistory.shift();
  localStorage.setItem('termai_hist', JSON.stringify(state.cmdHistory));
}

function getLastCmd() { return state.cmdHistory[state.cmdHistory.length-1] || ''; }

// ─── Prompt ───────────────────────────────────
function showPrompt(tab, newline = true) {
  const cwd    = (tab._cwd || '~').replace(getFilesDir(), '~');
  const prompt = `\x1b[32m\x1b[1m${cwd}\x1b[0m \x1b[35m❯\x1b[0m `;
  if (newline) tab.term.write('\r\n');
  tab.term.write(prompt);
  tab.inputBuffer = '';
}

function printWelcome(tab) {
  const v = isNative() ? 'Native Shell' : 'Demo Mode';
  tab.term.writeln(`\x1b[35m╔═══════════════════════════╗\x1b[0m`);
  tab.term.writeln(`\x1b[35m║\x1b[0m  \x1b[32m\x1b[1m⚡ TermAI\x1b[0m  Pro v2.0  \x1b[35m║\x1b[0m`);
  tab.term.writeln(`\x1b[35m╚═══════════════════════════╝\x1b[0m`);
  tab.term.writeln(`\x1b[2m${v} · !help for AI commands\x1b[0m`);
}

function printAIHelp(tab) {
  tab.term.writeln('\r\n\x1b[35m──── TermAI Commands ────\x1b[0m');
  [['!ai <question>','Ask AI anything'],
   ['!explain <cmd>','Explain a command'],
   ['!gen <desc>',   'Generate a script'],
   ['!help',         'Show this help']
  ].forEach(([cmd,desc]) =>
    tab.term.writeln(`\x1b[33m${cmd.padEnd(18)}\x1b[0m ${desc}`));
  showPrompt(tab);
}

// ─── Ctrl keys ────────────────────────────────
function handleCtrl(tab, key) {
  if (key === 'l') { tab.term.clear(); showPrompt(tab, false); }
  else if (key === 'c') {
    if (isNative()) Terminal().interrupt();
    tab.isRunning = false;
    tab.term.writeln('^C');
    showPrompt(tab);
  }
}

function sendKey(key)  {
  const tab = getActiveTab();
  if (!tab) return;
  if (tab.isRunning && isNative()) Terminal().writeStdin(key);
  else if (key === '\t') handleTabComplete(tab);
  else { tab.term.write(key); tab.inputBuffer += key; }
}

function sendCtrl(char) {
  const tab  = getActiveTab();
  if (!tab) return;
  const ctrl = String.fromCharCode(char.charCodeAt(0) - 96);
  if (char === 'c') { handleCtrl(tab, 'c'); return; }
  if (char === 'l') { handleCtrl(tab, 'l'); return; }
  if (tab.isRunning && isNative()) Terminal().writeStdin(ctrl);
}

// ─── Sleep mode ───────────────────────────────
function toggleSleepMode() { state.isSleeping ? wakeUp() : sleep(); }

function sleep() {
  state.isSleeping = true;
  document.getElementById('sleep-overlay').classList.remove('hidden');
  updateSleepClock();
  state.sleepTimer = setInterval(updateSleepClock, 1000);
}

function wakeUp() {
  state.isSleeping = false;
  document.getElementById('sleep-overlay').classList.add('hidden');
  clearInterval(state.sleepTimer);
  getActiveTab()?.term.focus();
}

function updateSleepClock() {
  const now = new Date();
  const h   = String(now.getHours()).padStart(2,'0');
  const m   = String(now.getMinutes()).padStart(2,'0');
  document.getElementById('sleep-clock').textContent = `${h}:${m}`;
  document.getElementById('sleep-date').textContent  =
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()] + ' ' +
    now.getDate() + ' ' +
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][now.getMonth()];
}

// ─── Settings ─────────────────────────────────
function openSettings() {
  document.getElementById('set-fontsize').value          = state.fontsize;
  document.getElementById('font-size-val').textContent   = state.fontsize;
  document.getElementById('set-theme').value             = state.theme;
  document.getElementById('set-ai-lang').value           = AI.lang;
  document.getElementById('set-auto-ai').checked         = AI.autoAnalyze;
  document.getElementById('set-security').checked        = AI.security;
  document.getElementById('set-endpoint').value          = AI.endpoint;
  document.getElementById('premium-status-display').innerHTML =
    (window.Billing?.getPremiumStatus?.() === 'active')
    ? '<span style="color:var(--primary)">✅ Premium Active</span>'
    : '<span style="color:var(--text2)">Free Plan</span>';
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings()          { document.getElementById('settings-overlay').classList.add('hidden'); }
function closeSettingsOnBg(e)     { if (e.target.id==='settings-overlay') closeSettings(); }

function saveSettings() {
  AI.setEndpoint(document.getElementById('set-endpoint').value.trim());
  AI.setLang(document.getElementById('set-ai-lang').value);
  AI.setAutoAnalyze(document.getElementById('set-auto-ai').checked);
  AI.setSecurity(document.getElementById('set-security').checked);
  localStorage.setItem('termai_scrollback', document.getElementById('set-scrollback').value);
  localStorage.setItem('termai_cursor', document.getElementById('set-cursor').value);
  closeSettings();
  showToast('Settings saved ✓');
}

function changeFontSize(val) {
  state.fontsize = parseInt(val);
  document.getElementById('font-size-val').textContent = val;
  localStorage.setItem('termai_fontsize', val);
  state.tabs.forEach(t => { t.term.options.fontSize = state.fontsize; t.fitAddon.fit(); });
}

function changeCursor(style) { state.tabs.forEach(t => t.term.options.cursorStyle = style); }

function applyTheme(name) {
  state.theme = name;
  localStorage.setItem('termai_theme', name);
  document.body.className = name !== 'dark' ? `theme-${name}` : '';
  const theme = getXtermTheme();
  state.tabs.forEach(t => t.term.options.theme = theme);
}

function setAILang(l)      { AI.setLang(l); }
function toggleAutoAI(v)   { AI.setAutoAnalyze(v); }
function toggleSecurity(v) { AI.setSecurity(v); }

// ─── Billing ─────────────────────────────────
function upgradeToPremium() {
  if (window.Billing) Billing().requestUpgrade('termai_premium_monthly');
  else showToast('Premium billing — install APK first');
}

window.onPremiumActivated = function(status) {
  AI.isPremium = (status === 'active');
  updateAIBadge(AI.isPremium);
  if (AI.isPremium) showToast('💎 Premium activated!');
};

// ─── Themes ───────────────────────────────────
function getXtermTheme() {
  const T = {
    dark:     { background:'#0d0d0f',foreground:'#e8e8e8',cursor:'#00e676',black:'#1a1a1a',red:'#ff5555',green:'#00e676',yellow:'#ffb86c',blue:'#7cb7ff',magenta:'#bd93f9',cyan:'#00d4ff',white:'#f8f8f2',brightBlack:'#555',brightRed:'#ff6e6e',brightGreen:'#69ff47',brightYellow:'#ffffa5',brightBlue:'#d6acff',brightMagenta:'#ff92df',brightCyan:'#a4ffff',brightWhite:'#fff' },
    matrix:   { background:'#000800',foreground:'#00ff00',cursor:'#00ff00',black:'#001000',red:'#004400',green:'#00cc00',yellow:'#007700',blue:'#003300',magenta:'#005500',cyan:'#006600',white:'#00aa00' },
    ocean:    { background:'#050f1a',foreground:'#cce8ff',cursor:'#00d4ff',black:'#0a1c30',red:'#ff6b6b',green:'#00e676',yellow:'#ffd166',blue:'#4facfe',magenta:'#b388ff',cyan:'#00d4ff',white:'#e8f4f8' },
    hacker:   { background:'#0a0000',foreground:'#ffcccc',cursor:'#ff2020',black:'#1a0000',red:'#ff2020',green:'#cc0000',yellow:'#ff6600',blue:'#aa0000',magenta:'#ff0066',cyan:'#cc3333',white:'#ffaaaa' },
    midnight: { background:'#090a14',foreground:'#e2e0f0',cursor:'#a78bfa',black:'#1e2240',red:'#ff6b9d',green:'#00e676',yellow:'#ffd166',blue:'#7cb7ff',magenta:'#a78bfa',cyan:'#67e8f9',white:'#f0f0ff' },
  };
  return T[state.theme] || T.dark;
}

// ─── Helpers ──────────────────────────────────
function updateAIBadge(online) {
  const b = document.getElementById('ai-badge');
  if (b) b.className = online ? 'badge-online' : 'badge-offline';
}

function updatePwdDisplay(cwd) {
  if (cwd) getActiveTab() && (getActiveTab()._cwd = cwd);
  const display = (cwd || getActiveTab()?._cwd || '~').replace(getFilesDir(),'~');
  const el = document.getElementById('pwd-display');
  if (el) el.textContent = display.length > 22 ? '…'+display.slice(-20) : display;
}

function getFilesDir() {
  return '/data/data/com.termai/files/home';
}

function showToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:12px;padding:8px 16px;border-radius:20px;z-index:9999;pointer-events:none';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function copyText(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => showToast('Copied ✓'));
  else if (window.Terminal) Terminal().copyToClipboard(text);
}

function simulateDemoCommand(tab, cmd) {
  const demo = { pwd:'/home/termai', whoami:'termai', date:new Date().toString(),
    ls:'Documents  Downloads  Projects  scripts', 'uname -a':'Linux termai 5.10 Android aarch64' };
  tab.term.writeln(demo[cmd] || `\x1b[33m[Demo] ${cmd}\x1b[0m`);
  tab.isRunning = false;
  showPrompt(tab);
}

// ─── Init ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (state.theme !== 'dark') document.body.className = `theme-${state.theme}`;

  // Check premium on load
  if (window.Billing) {
    AI.isPremium = Billing().getPremiumStatus() === 'active';
    updateAIBadge(AI.isPremium);
  }

  createTab('Shell 1');

  document.addEventListener('backbutton', e => {
    e.preventDefault();
    if (state.isSleeping) { wakeUp(); return; }
    if (!document.getElementById('ai-panel').classList.contains('hidden')) { closeAIPanel(); return; }
    if (!document.getElementById('settings-overlay').classList.contains('hidden')) { closeSettings(); return; }
  });

  document.getElementById('terminal-container').addEventListener('click', () => {
    getActiveTab()?.term.focus();
  });
});
