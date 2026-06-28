/* ═══════════════════════════════════════════
   TermAI v2 — Terminal Core
   All buttons wired. All features real.
   ═══════════════════════════════════════════ */

'use strict';

// ─── State ───────────────────────────────────
const state = {
  tabs:         [],
  activeTab:    null,
  tabCounter:   0,
  isSleeping:   false,
  sleepTimer:   null,
  fontsize:     parseInt(ls('termai_fontsize')) || 14,
  theme:        ls('termai_theme') || 'dark',
  cmdHistory:   JSON.parse(ls('termai_hist') || '[]'),
  historyIdx:   -1,
  currentInput: '',
  sessionId:    'sess_' + Date.now(),
  pendingCmd:   null,  // waiting for security confirm
};

// ─── JS callback registry ─────────────────────
window.terminalCallbacks = {};

// ─── Streaming chunk handler ──────────────────
window.onShellChunk = function(sessionId, chunk) {
  if (sessionId !== state.sessionId) return;
  const tab = activeTab();
  if (tab) tab.term.write(chunk);
};

// ─── Android bridge shims ─────────────────────
const Native = {
  terminal: () => window.Terminal  || null,
  billing:  () => window.Billing   || null,
  settings: () => window.Settings  || null,
  ok:       () => !!window.Terminal,
};

// ─── localStorage helpers ─────────────────────
function ls(key, val) {
  try {
    if (val !== undefined) localStorage.setItem(key, val);
    return localStorage.getItem(key);
  } catch { return null; }
}

// ══════════════════════════════════════════════
//  TAB MANAGEMENT
// ══════════════════════════════════════════════

function createTab(label) {
  const id   = ++state.tabCounter;
  const name = label || `Shell ${id}`;

  const theme      = getXtermTheme();
  const scrollback = parseInt(ls('termai_scrollback')) || 5000;
  const cursor     = ls('termai_cursor') || 'block';

  const term = new Terminal({
    fontFamily:  "'JetBrains Mono','Fira Code',monospace",
    fontSize:    state.fontsize,
    lineHeight:  1.2,
    theme,
    cursorBlink: true,
    cursorStyle: cursor,
    scrollback,
    allowTransparency: true,
    convertEol:  false,
  });

  const fitAddon      = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  const tab = {
    id, name, term, fitAddon,
    inputBuffer:     '',
    isRunning:       false,
    callbackId:      null,
    _cwd:            '~',
    _awaitProceed:   false,
    _pendingCmd:     null,
  };

  state.tabs.push(tab);
  renderTabs();
  switchTab(id);

  term.open(document.getElementById('terminal'));
  setTimeout(() => { fitAddon.fit(); term.focus(); }, 60);



  new ResizeObserver(() => { try { fitAddon.fit(); } catch {} })
    .observe(document.getElementById('terminal-container'));

  setupInput(tab);
  printWelcome(tab);
  showPrompt(tab);
  return tab;
}

function addTab()       { createTab(); }
function getTab(id)     { return state.tabs.find(t => t.id === id); }
function activeTab()    { return getTab(state.activeTab); }

function switchTab(id) {
  document.getElementById('terminal').innerHTML = '';
  state.activeTab = id;
  const tab = getTab(id);
  if (!tab) return;
  tab.term.open(document.getElementById('terminal'));
  setTimeout(() => { tab.fitAddon.fit(); tab.term.focus(); }, 60);
  renderTabs();
  updatePwdDisplay(tab._cwd);
}

function closeTab(id, e) {
  if (e) e.stopPropagation();
  if (state.tabs.length === 1) return;
  const idx = state.tabs.findIndex(t => t.id === id);
  state.tabs.splice(idx, 1);
  if (state.activeTab === id) {
    switchTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
  }
  renderTabs();
}

function renderTabs() {
  document.getElementById('tabs-list').innerHTML = state.tabs.map(t => `
    <div class="tab-item ${t.id === state.activeTab ? 'active' : ''}" onclick="switchTab(${t.id})">
      <span class="tab-dot"></span>
      <span class="tab-label">${escHtml(t.name)}</span>
      ${state.tabs.length > 1
        ? `<span class="tab-close" onclick="closeTab(${t.id},event)">✕</span>`
        : ''}
    </div>`).join('');
}

// ══════════════════════════════════════════════
//  INPUT HANDLING
// ══════════════════════════════════════════════

function setupInput(tab) {
  tab.term.onKey(({ key, domEvent }) => {
    if (state.isSleeping) { wakeUp(); return; }

    // If running: forward to shell
    if (tab.isRunning) {
      if (Native.ok()) Native.terminal().writeStdin(key);
      return;
    }

    const code = domEvent.keyCode;
    if      (code === 13)  handleEnter(tab);
    else if (code === 8)   handleBackspace(tab);
    else if (code === 9)   handleTabComplete(tab);
    else if (code === 38)  navigateHistory(tab, -1);
    else if (code === 40)  navigateHistory(tab,  1);
    else if (domEvent.ctrlKey) handleCtrl(tab, domEvent.key.toLowerCase());
    else if (key.length === 1 && !domEvent.ctrlKey && !domEvent.metaKey) {
      tab.inputBuffer += key;
      tab.term.write(key);
    }
  });

  // Long press selection support
  tab.term.onSelectionChange(() => {
    const sel = tab.term.getSelection();
    if (sel && Native.ok()) {
      try { Native.terminal().copyToClipboard(sel); } catch {}
    }
  });
}

function handleBackspace(tab) {
  if (!tab.inputBuffer.length) return;
  tab.inputBuffer = tab.inputBuffer.slice(0, -1);
  tab.term.write('\b \b');
}

async function handleEnter(tab) {
  const cmd = tab.inputBuffer.trim();
  tab.term.write('\r\n');
  tab.inputBuffer = '';
  state.historyIdx = -1;

  // Awaiting security confirmation
  if (tab._awaitProceed) {
    tab._awaitProceed = false;
    if (cmd === '!proceed' || cmd === 'y' || cmd === 'yes') {
      const pending = tab._pendingCmd;
      tab._pendingCmd = null;
      executeCommand(tab, pending);
    } else {
      tab.term.writeln('\x1b[33mCancelled.\x1b[0m');
      showPrompt(tab);
    }
    return;
  }

  if (!cmd) { showPrompt(tab); return; }

  addToHistory(cmd);

  // Built-in commands
  if (await handleBuiltins(tab, cmd)) return;

  // Security scan
  if (Native.ok()) {
    try {
      const scanRaw = Native.terminal().securityScan(cmd);
      const scan    = JSON.parse(scanRaw || '{"safe":true}');
      if (scan.blocked) {
        showSecurityBlocked(tab, scan);
        return;
      }
      if (!scan.safe && scan.risk !== 'LOW') {
        showSecurityWarning(tab, cmd, scan);
        return;
      }
    } catch {}
  }

  executeCommand(tab, cmd);
}

// ══════════════════════════════════════════════
//  EXECUTION
// ══════════════════════════════════════════════

function executeCommand(tab, cmd) {
  tab.isRunning = true;
  updatePwdDisplay(tab._cwd);

  if (Native.ok()) {
    const cbId = `cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    tab.callbackId = cbId;

    window.terminalCallbacks[cbId] = (result) => {
      delete window.terminalCallbacks[cbId];
      tab.callbackId = null;
      tab.isRunning  = false;

      try {
        const r = typeof result === 'string' ? JSON.parse(result) : result;
        if (r.cwd) { tab._cwd = r.cwd; updatePwdDisplay(r.cwd); }

        // Auto AI error analysis
        if (r.exitCode !== 0 && AI.autoAnalyze && AI.isPremium) {
          analyzeError(tab, cmd, r.exitCode);
        }
      } catch {}

      showPrompt(tab);
    };

    Native.terminal().executeCommand(cmd, state.sessionId, cbId);
  } else {
    demoBrowser(tab, cmd);
  }
}

// ══════════════════════════════════════════════
//  BUILT-IN COMMANDS
// ══════════════════════════════════════════════

async function handleBuiltins(tab, cmd) {
  if (cmd === 'clear' || cmd === 'cls') {
    tab.term.clear(); showPrompt(tab); return true;
  }
  if (cmd === 'exit') {
    if (state.tabs.length > 1) closeTab(tab.id);
    else { tab.term.writeln('\x1b[33mType Ctrl+D to close the session.\x1b[0m'); showPrompt(tab); }
    return true;
  }
  if (cmd === '!help')     { printAIHelp(tab); return true; }
  if (cmd === '!stats')    { printStats(tab);  return true; }
  if (cmd === '!clear-ai') { AI.history = []; showToast('AI history cleared'); showPrompt(tab); return true; }

  if (cmd.startsWith('!ai')) {
    const q = cmd.slice(3).trim();
    if (q) await runAIChat(tab, q);
    else showPrompt(tab);
    return true;
  }
  if (cmd.startsWith('!explain')) {
    const target = cmd.slice(8).trim() || getLastCmd();
    if (target) await showAIExplain(tab, target);
    else showPrompt(tab);
    return true;
  }
  if (cmd.startsWith('!gen ')) {
    await showAIGenerate(tab, cmd.slice(5));
    return true;
  }
  if (cmd.startsWith('!plan ')) {
    await AIPlanner.run(cmd.slice(6));
    showPrompt(tab);
    return true;
  }

  return false;
}

// ══════════════════════════════════════════════
//  SECURITY UI
// ══════════════════════════════════════════════

function showSecurityBlocked(tab, scan) {
  tab.term.writeln(`\r\n\x1b[31m⛔ BLOCKED [${scan.risk}]: ${scan.reason}\x1b[0m`);
  if (scan.detail) tab.term.writeln(`\x1b[2m  ${scan.detail}\x1b[0m`);
  tab.isRunning = false;
  showPrompt(tab);
}

function showSecurityWarning(tab, cmd, scan) {
  const color = scan.risk === 'HIGH' ? '\x1b[31m' : '\x1b[33m';
  tab.term.writeln(`\r\n${color}⚠️  [${scan.risk}] ${scan.reason}\x1b[0m`);
  if (scan.detail) tab.term.writeln(`\x1b[2m  ${scan.detail}\x1b[0m`);
  tab.term.writeln('\x1b[2m  Type \x1b[0m\x1b[33m!proceed\x1b[0m\x1b[2m to run or Enter to cancel:\x1b[0m');
  tab._awaitProceed = true;
  tab._pendingCmd   = cmd;
  showPrompt(tab, false);
}

// ══════════════════════════════════════════════
//  AI FEATURES
// ══════════════════════════════════════════════

async function analyzeError(tab, cmd, exitCode) {
  try {
    showAIPanel({ loading: true, label: '🔴 Error Analysis' });
    const result = await AI.analyzeError(cmd, '', exitCode);
    const fix    = AI.extractCommand(result);
    showAIPanel({
      loading: false, label: '🔴 Error Analysis', content: result,
      actions: fix
        ? [{ label: '⚡ Apply Fix', primary: true, fn: () => applyFix(fix) },
           { label: 'Dismiss', fn: closeAIPanel }]
        : [{ label: 'Dismiss', fn: closeAIPanel }]
    });
  } catch(e) { handleAIError(e); }
}

async function showAIExplain(tab, cmd) {
  showAIPanel({ loading: true, label: `📖 Explain: ${cmd.slice(0,30)}` });
  try {
    const r = await AI.explainCommand(cmd);
    showAIPanel({
      loading: false, label: `📖 ${cmd.slice(0,25)}`, content: r,
      actions: [{ label: 'Close', fn: closeAIPanel }]
    });
  } catch(e) { handleAIError(e); }
}

async function showAIGenerate(tab, desc) {
  showAIPanel({ loading: true, label: '📜 Generating Script...' });
  try {
    const r = await AI.generateScript(desc);
    showAIPanel({
      loading: false, label: '📜 Generated Script', content: r,
      actions: [
        { label: '▶ Run',  primary: true, fn: () => runScript(r) },
        { label: '📋 Copy',             fn: () => { copyText(r); showToast('Copied ✓', 'success'); } },
        { label: 'Close',               fn: closeAIPanel }
      ]
    });
  } catch(e) { handleAIError(e); }
}

async function runAIChat(tab, message) {
  showAIPanel({ loading: true, label: '🤖 TermAI' });
  try {
    const r   = await AI.chat(message);
    const fix = AI.extractCommand(r);
    showAIPanel({
      loading: false, label: '🤖 TermAI', content: r,
      actions: fix
        ? [{ label: '▶ Run',  primary: true, fn: () => applyFix(fix) },
           { label: '📋 Copy',            fn: () => copyText(fix) },
           { label: 'Close',              fn: closeAIPanel }]
        : [{ label: 'Close', fn: closeAIPanel }]
    });
  } catch(e) { handleAIError(e); }
}

function quickAI() {
  const tab = activeTab();
  const cur = tab?.inputBuffer?.trim();
  if (cur) {
    showAIExplain(tab, cur);
  } else {
    // Show input prompt in AI panel
    showAIPanel({
      loading: false, label: '🤖 Ask TermAI',
      content: '<input id="ai-quick-input" class="text-input" placeholder="Ask anything about Linux, shell, code..." style="margin-top:4px" autocomplete="off">',
      actions: [
        { label: '▶ Ask', primary: true, fn: () => {
          const q = document.getElementById('ai-quick-input')?.value?.trim();
          if (q) runAIChat(tab, q);
        }},
        { label: 'Cancel', fn: closeAIPanel }
      ],
      raw: true
    });
    setTimeout(() => document.getElementById('ai-quick-input')?.focus(), 100);
  }
}

function applyFix(cmd) {
  closeAIPanel();
  const tab = activeTab();
  if (!tab || !cmd) return;
  tab.inputBuffer = cmd;
  tab.term.write('\r\n');
  tab.term.write(cmd);
  handleEnter(tab);
}

function runScript(script) {
  closeAIPanel();
  const tab = activeTab();
  if (!tab || !script) return;
  // Write to tmp file and execute
  const tmpScript = `/tmp/termai_${Date.now()}.sh`;
  const safeScript = script.replace(/'/g, "'\\''");
  const steps = [
    `printf '%s' '${safeScript}' > ${tmpScript}`,
    `chmod +x ${tmpScript} && bash ${tmpScript}`,
  ];
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    tab.inputBuffer = steps[i++];
    handleEnter(tab);
    setTimeout(next, 400);
  };
  next();
}

// ══════════════════════════════════════════════
//  AI PANEL
// ══════════════════════════════════════════════

function showAIPanel({ loading, label, content, actions, raw }) {
  const panel = document.getElementById('ai-panel');
  panel.classList.remove('hidden');
  document.getElementById('ai-panel-label').textContent = label || 'TermAI';

  const cEl = document.getElementById('ai-content');
  if (loading) {
    cEl.innerHTML = `<div class="ai-loading"><div class="spinner"></div><span>Processing…</span></div>`;
  } else if (raw) {
    cEl.innerHTML = content || '';
  } else {
    cEl.innerHTML = formatAIContent(content || '');
  }

  const aEl = document.getElementById('ai-actions');
  aEl.innerHTML = '';
  if (actions) {
    actions.forEach((a, i) => {
      const btn = document.createElement('button');
      btn.className = `ai-action-btn${a.primary ? ' primary' : ''}`;
      btn.textContent = a.label;
      btn.onclick = a.fn;
      aEl.appendChild(btn);
    });
  }
}

function formatAIContent(text) {
  // Format: escape HTML, convert code blocks, format tags
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Block code (```...```)
  html = html.replace(/```[\s\S]*?```/g, m => {
    const code = m.replace(/^```\w*\n?/, '').replace(/```$/, '');
    return `<code class="ai-block-code">${code}</code>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`\n]+)`/g,
    (_, c) => `<code class="ai-inline-code">${c}</code>`);

  // [TAGS]
  html = html.replace(/\[([A-Z]+)\]/g,
    (_, t) => `<span class="ai-tag">[${t}]</span>`);

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return `<div class="ai-section">${html}</div>`;
}

function closeAIPanel() {
  document.getElementById('ai-panel').classList.add('hidden');
}

function handleAIError(e) {
  const msg =
    e.message === 'NOT_PREMIUM' ? 'Upgrade to Premium to use AI features.' :
    e.message === 'NO_ENDPOINT' ? 'Set your API endpoint in Settings.' :
    `Error: ${e.message}`;

  showAIPanel({
    loading: false, label: '⚠️ AI Error', content: msg,
    actions: [
      e.message === 'NOT_PREMIUM'
        ? { label: '💎 Upgrade', primary: true, fn: () => { closeAIPanel(); openSettings(); } }
        : { label: '⚙️ Settings', primary: true, fn: () => { closeAIPanel(); openSettings(); } },
      { label: 'Close', fn: closeAIPanel }
    ]
  });
}

// ══════════════════════════════════════════════
//  AUTOCOMPLETE (Tab key)
// ══════════════════════════════════════════════

async function handleTabComplete(tab) {
  const buf = tab.inputBuffer;
  if (!buf) return;

  // Basic path/command completion via shell
  if (Native.ok()) {
    try {
      const cbId = `ac_${Date.now()}`;
      const result = await new Promise((res, rej) => {
        window.terminalCallbacks[cbId] = (r) => {
          delete window.terminalCallbacks[cbId];
          res(r);
        };
        Native.terminal().requestCompletion(buf, cbId);
        setTimeout(() => { delete window.terminalCallbacks[cbId]; rej(new Error('timeout')); }, 2000);
      });
      const completions = JSON.parse(result || '[]');
      if (!completions.length) return;
      if (completions.length === 1) {
        const add = completions[0].slice(buf.length);
        tab.inputBuffer += add;
        tab.term.write(add);
      } else {
        tab.term.writeln('');
        tab.term.writeln('\x1b[2m' + completions.join('  ') + '\x1b[0m');
        showPrompt(tab, false);
        tab.term.write(tab.inputBuffer);
      }
      return;
    } catch {}
  }

  // AI autocomplete (premium)
  if (AI.isPremium && AI.endpoint) {
    try {
      const suggestions = await AI.autocomplete(buf, state.cmdHistory.slice(-8));
      if (!suggestions.length) return;
      if (suggestions.length === 1) {
        const add = suggestions[0].slice(buf.length);
        tab.inputBuffer = suggestions[0];
        tab.term.write(add);
      } else {
        tab.term.writeln('');
        tab.term.writeln('\x1b[35m' + suggestions.join('  ') + '\x1b[0m');
        showPrompt(tab, false);
        tab.term.write(tab.inputBuffer);
      }
    } catch {}
  }
}

// ══════════════════════════════════════════════
//  HISTORY
// ══════════════════════════════════════════════

function navigateHistory(tab, dir) {
  const hist = state.cmdHistory;
  if (!hist.length) return;

  if (state.historyIdx === -1 && dir === -1) {
    state.currentInput = tab.inputBuffer;
    state.historyIdx   = hist.length - 1;
  } else {
    state.historyIdx = Math.max(0, Math.min(hist.length - 1, state.historyIdx + dir));
  }

  const newCmd = dir === 1 && state.historyIdx === hist.length - 1
    ? state.currentInput
    : hist[state.historyIdx] || '';

  tab.term.write('\r\x1b[K');
  showPrompt(tab, false);
  tab.inputBuffer = newCmd;
  tab.term.write(newCmd);
}

function addToHistory(cmd) {
  const last = state.cmdHistory[state.cmdHistory.length - 1];
  if (last === cmd) return;
  state.cmdHistory.push(cmd);
  if (state.cmdHistory.length > 1000) state.cmdHistory.shift();
  ls('termai_hist', JSON.stringify(state.cmdHistory.slice(-500)));
}

function getLastCmd() { return state.cmdHistory[state.cmdHistory.length - 1] || ''; }

function clearHistory() {
  if (!confirm('Clear command history?')) return;
  state.cmdHistory = [];
  ls('termai_hist', '[]');
  showToast('History cleared', 'success');
}

// ══════════════════════════════════════════════
//  PROMPT & WELCOME
// ══════════════════════════════════════════════

function showPrompt(tab, newline = true) {
  const home = '/data/data/com.termai/files/home';
  const cwd  = (tab._cwd || '~').replace(home, '~');
  const p    = `\x1b[32m\x1b[1m${cwd}\x1b[0m \x1b[35m❯\x1b[0m `;
  if (newline) tab.term.write('\r\n');
  tab.term.write(p);
  tab.inputBuffer = '';
}

function printWelcome(tab) {
  const mode = Native.ok() ? '\x1b[32mNative Shell\x1b[0m' : '\x1b[33mDemo Mode\x1b[0m';
  tab.term.writeln('\x1b[35m╔═══════════════════════════════╗\x1b[0m');
  tab.term.writeln('\x1b[35m║\x1b[0m  \x1b[32m\x1b[1m⚡ TermAI\x1b[0m  \x1b[2mv2.0 Pro\x1b[0m          \x1b[35m║\x1b[0m');
  tab.term.writeln(`\x1b[35m║\x1b[0m  ${mode}  \x1b[2m· type !help\x1b[0m      \x1b[35m║\x1b[0m`);
  tab.term.writeln('\x1b[35m╚═══════════════════════════════╝\x1b[0m');
}

function printAIHelp(tab) {
  tab.term.writeln('\r\n\x1b[35m──────────── TermAI Commands ────────────\x1b[0m');
  const cmds = [
    ['!ai <question>',  'Ask AI anything'],
    ['!explain <cmd>',  'Explain a command in detail'],
    ['!gen <desc>',     'Generate a bash script'],
    ['!plan <task>',    'AI creates multi-step plan'],
    ['!stats',          'Show session stats'],
    ['!clear-ai',       'Clear AI conversation history'],
    ['!help',           'Show this help'],
    ['Tab',             'Autocomplete command/path'],
    ['↑ / ↓',           'Navigate command history'],
    ['C-C',             'Cancel current command'],
    ['C-L',             'Clear terminal screen'],
  ];
  cmds.forEach(([cmd, desc]) =>
    tab.term.writeln(`  \x1b[33m${cmd.padEnd(18)}\x1b[0m \x1b[2m${desc}\x1b[0m`));
  tab.term.writeln('\x1b[35m─────────────────────────────────────────\x1b[0m');
  showPrompt(tab);
}

function printStats(tab) {
  const stats = Native.ok() ? JSON.parse(Native.terminal()?.getStats?.() || '{}') : {};
  tab.term.writeln('\r\n\x1b[35m──── Session Stats ────\x1b[0m');
  tab.term.writeln(`  AI calls:   \x1b[33m${AI.callCount || 0}\x1b[0m`);
  tab.term.writeln(`  History:    \x1b[33m${state.cmdHistory.length}\x1b[0m cmds`);
  tab.term.writeln(`  Tabs:       \x1b[33m${state.tabs.length}\x1b[0m`);
  tab.term.writeln(`  Premium:    \x1b[${AI.isPremium?'32':'31'}m${AI.isPremium?'Active':'Free'}\x1b[0m`);
  tab.term.writeln(`  AI online:  \x1b[${AI.online?'32':'31'}m${AI.online?'Yes':'No'}\x1b[0m`);
  showPrompt(tab);
}

// ══════════════════════════════════════════════
//  CTRL KEYS
// ══════════════════════════════════════════════

function handleCtrl(tab, key) {
  switch(key) {
    case 'l':
      tab.term.clear();
      showPrompt(tab, false);
      break;
    case 'c':
      if (Native.ok()) Native.terminal().interrupt();
      tab.isRunning = false;
      tab.term.writeln('^C');
      showPrompt(tab);
      break;
    case 'd':
      if (!tab.inputBuffer.length) {
        if (state.tabs.length > 1) closeTab(tab.id);
        else tab.term.writeln('\x1b[2m[Ctrl+D: last session]\x1b[0m');
      }
      break;
    case 'a':
      // Move to line start (re-write prompt + buffer)
      tab.term.write('\r\x1b[K');
      showPrompt(tab, false);
      tab.term.write(tab.inputBuffer);
      break;
    case 'u':
      // Clear line
      tab.inputBuffer = '';
      tab.term.write('\r\x1b[K');
      showPrompt(tab, false);
      break;
    case 'w':
      // Delete last word
      const parts = tab.inputBuffer.trimEnd().split(' ');
      parts.pop();
      tab.inputBuffer = parts.join(' ') + (parts.length ? ' ' : '');
      tab.term.write('\r\x1b[K');
      showPrompt(tab, false);
      tab.term.write(tab.inputBuffer);
      break;
    case 'z':
      if (Native.ok()) Native.terminal().writeStdin('\x1a');
      break;
  }
}

function sendKey(key) {
  const tab = activeTab();
  if (!tab) return;
  if (key === '\t') { handleTabComplete(tab); return; }
  if (tab.isRunning) {
    if (Native.ok()) Native.terminal().writeStdin(key);
  } else {
    tab.inputBuffer += key;
    tab.term.write(key);
  }
}

function insertChar(c) {
  const tab = activeTab();
  if (!tab || tab.isRunning) return;
  tab.inputBuffer += c;
  tab.term.write(c);
}

function sendCtrl(char) {
  const tab = activeTab();
  if (!tab) return;
  handleCtrl(tab, char);
}

// ══════════════════════════════════════════════
//  SLEEP MODE
// ══════════════════════════════════════════════

function toggleSleepMode() { state.isSleeping ? wakeUp() : goSleep(); }

function goSleep() {
  state.isSleeping = true;
  document.getElementById('sleep-overlay').classList.remove('hidden');
  updateSleepClock();
  state.sleepTimer = setInterval(updateSleepClock, 1000);
}

function wakeUp() {
  state.isSleeping = false;
  document.getElementById('sleep-overlay').classList.add('hidden');
  clearInterval(state.sleepTimer);
  activeTab()?.term.focus();
}

function updateSleepClock() {
  const now = new Date();
  const h   = String(now.getHours()).padStart(2, '0');
  const m   = String(now.getMinutes()).padStart(2, '0');
  const days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months= ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  document.getElementById('sleep-clock').textContent = `${h}:${m}`;
  document.getElementById('sleep-date').textContent  =
    `${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]}`;
}

// ══════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════

function openSettings() {
  // Load current values
  document.getElementById('set-fontsize').value        = state.fontsize;
  document.getElementById('font-size-val').textContent = state.fontsize;
  document.getElementById('set-theme').value           = state.theme;
  document.getElementById('set-ai-lang').value         = AI.lang;
  document.getElementById('set-auto-ai').checked       = AI.autoAnalyze;
  document.getElementById('set-security').checked      = AI.security;
  document.getElementById('set-endpoint').value        = AI.endpoint;
  document.getElementById('set-scrollback').value      = ls('termai_scrollback') || '5000';
  document.getElementById('set-cursor').value          = ls('termai_cursor')     || 'block';

  // Premium status
  const isPro = Native.billing()?.getPremiumStatus?.() === 'active' || AI.isPremium;
  document.getElementById('premium-status-display').innerHTML = isPro
    ? '<span style="color:var(--primary)">✅ Premium Active</span>'
    : '<span style="color:var(--text2)">Free Plan — 7-day trial available</span>';

  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings()      { document.getElementById('settings-overlay').classList.add('hidden'); }
function closeSettingsOnBg(e) { if (e.target.id === 'settings-overlay') closeSettings(); }

function saveSettings() {
  const endpoint = document.getElementById('set-endpoint').value.trim();
  const lang     = document.getElementById('set-ai-lang').value;
  const autoAI   = document.getElementById('set-auto-ai').checked;
  const security = document.getElementById('set-security').checked;
  const scrollback = document.getElementById('set-scrollback').value;
  const cursor     = document.getElementById('set-cursor').value;

  AI.setEndpoint(endpoint);
  AI.setLang(lang);
  AI.setAutoAnalyze(autoAI);
  AI.setSecurity(security);

  ls('termai_scrollback', scrollback);
  ls('termai_cursor', cursor);

  // Persist to native SettingsManager if available
  if (Native.settings()) {
    try {
      Native.settings().setString('ai_endpoint', endpoint);
      Native.settings().setString('ai_lang', lang);
      Native.settings().setBool('ai_auto_error', autoAI);
      Native.settings().setBool('sec_sandbox', false);
    } catch {}
  }

  closeSettings();
  showToast('Settings saved ✓', 'success');
}

function changeFontSize(val) {
  state.fontsize = parseInt(val);
  document.getElementById('font-size-val').textContent = val;
  ls('termai_fontsize', val);
  state.tabs.forEach(t => { t.term.options.fontSize = state.fontsize; t.fitAddon.fit(); });
}

function changeCursor(style) {
  ls('termai_cursor', style);
  state.tabs.forEach(t => t.term.options.cursorStyle = style);
}

function applyTheme(name) {
  state.theme = name;
  ls('termai_theme', name);
  document.body.className = name !== 'dark' ? `theme-${name}` : '';
  const theme = getXtermTheme();
  state.tabs.forEach(t => t.term.options.theme = theme);
}

async function testAIConnection() {
  const endpoint = document.getElementById('set-endpoint').value.trim();
  if (!endpoint) { showToast('Enter an endpoint URL first', 'error'); return; }
  const btn = document.querySelector('.test-btn');
  btn.textContent = '⏳ Testing…';
  btn.disabled = true;
  try {
    const r = await fetch(endpoint + '?ping=1', { signal: AbortSignal.timeout(6000) });
    btn.textContent = '🔗 Test Connection';
    btn.disabled = false;
    if (r.ok) showToast('✅ Connection successful!', 'success');
    else showToast(`❌ Server error: ${r.status}`, 'error');
  } catch(e) {
    btn.textContent = '🔗 Test Connection';
    btn.disabled = false;
    showToast('❌ Cannot reach endpoint', 'error');
  }
}

function viewSecurityLog() {
  if (Native.ok()) {
    try {
      const log = Native.terminal().getSecurityLog?.() || 'No log available';
      showAIPanel({ loading: false, label: '🔒 Security Audit', content: log,
        actions: [{ label: 'Close', fn: closeAIPanel }] });
    } catch { showToast('Log not available', 'error'); }
  } else {
    showToast('Available in native mode', 'error');
  }
  closeSettings();
}

// ══════════════════════════════════════════════
//  BILLING / PREMIUM
// ══════════════════════════════════════════════

function upgradeToPremium() {
  if (Native.billing()) {
    Native.billing().requestUpgrade('termai_premium_monthly');
  } else {
    showToast('Install APK to upgrade', 'error');
  }
}

function startTrial() {
  if (Native.billing()) {
    try {
      const r = JSON.parse(Native.billing().startTrial());
      if (r.ok) {
        AI.isPremium = true;
        updateAIBadge(true);
        showToast('🎉 7-day trial started!', 'success');
        closeSettings();
      } else {
        showToast(r.reason || 'Trial not available', 'error');
      }
    } catch { showToast('Trial failed', 'error'); }
  } else {
    showToast('Install APK to start trial', 'error');
  }
}

window.onPremiumActivated = function(status) {
  AI.isPremium = (status === 'active');
  updateAIBadge(AI.isPremium);
  updatePremiumBadge(AI.isPremium);
  if (AI.isPremium) showToast('💎 Premium activated!', 'success');
};

// ══════════════════════════════════════════════
//  THEMES
// ══════════════════════════════════════════════

function getXtermTheme() {
  const T = {
    dark:      { background:'#0d0d0f',foreground:'#e8e8ec',cursor:'#00e676',cursorAccent:'#0d0d0f',black:'#1a1a20',red:'#ff4455',green:'#00e676',yellow:'#ffb86c',blue:'#7cb7ff',magenta:'#bd93f9',cyan:'#00d4ff',white:'#f8f8f8',brightBlack:'#55555f',brightRed:'#ff6e7e',brightGreen:'#69ff47',brightYellow:'#ffffa5',brightBlue:'#d6acff',brightMagenta:'#ff92df',brightCyan:'#a4ffff',brightWhite:'#fff' },
    matrix:    { background:'#000800',foreground:'#00ff41',cursor:'#00ff41',black:'#001000',red:'#004400',green:'#00ff41',yellow:'#007700',blue:'#003300',magenta:'#005500',cyan:'#006600',white:'#00aa00',brightBlack:'#003300',brightGreen:'#44ff44',brightWhite:'#00ff41' },
    ocean:     { background:'#040e1a',foreground:'#c8e8ff',cursor:'#00d4ff',black:'#071525',red:'#ff6b6b',green:'#00e676',yellow:'#ffd166',blue:'#4facfe',magenta:'#b388ff',cyan:'#00d4ff',white:'#e8f4ff',brightBlue:'#79cfff',brightCyan:'#44eeff' },
    hacker:    { background:'#0a0000',foreground:'#ffdddd',cursor:'#ff2020',black:'#180000',red:'#ff2020',green:'#cc0000',yellow:'#ff6600',blue:'#aa0000',magenta:'#ff0066',cyan:'#cc3333',white:'#ffaaaa',brightRed:'#ff5555' },
    midnight:  { background:'#08091a',foreground:'#e0e0f8',cursor:'#a78bfa',black:'#1c2040',red:'#ff6b9d',green:'#00e676',yellow:'#ffd166',blue:'#7cb7ff',magenta:'#a78bfa',cyan:'#67e8f9',white:'#f0f0ff',brightMagenta:'#c4b5fd' },
    solarized: { background:'#002b36',foreground:'#839496',cursor:'#2aa198',black:'#073642',red:'#dc322f',green:'#859900',yellow:'#b58900',blue:'#268bd2',magenta:'#6c71c4',cyan:'#2aa198',white:'#eee8d5',brightBlack:'#586e75',brightWhite:'#fdf6e3' },
  };
  return T[state.theme] || T.dark;
}

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════

function updateAIBadge(online) {
  const b = document.getElementById('ai-badge');
  if (b) b.className = `badge ${online ? 'badge-online' : 'badge-offline'}`;
}

function updatePremiumBadge(active) {
  const b = document.getElementById('premium-badge');
  if (b) b.classList.toggle('hidden', !active);
}

function updatePwdDisplay(cwd) {
  if (!cwd) cwd = activeTab()?._cwd || '~';
  const home = '/data/data/com.termai/files/home';
  const display = cwd.replace(home, '~');
  const el = document.getElementById('pwd-display');
  if (el) el.textContent = display.length > 24 ? '…' + display.slice(-22) : display;
}

function showToast(msg, type = '') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast${type ? ' ' + type : ''}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 2700);
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied ✓', 'success'));
  } else if (Native.ok()) {
    try { Native.terminal().copyToClipboard(text); showToast('Copied ✓', 'success'); } catch {}
  }
}

function cancelDangerCmd()  { document.getElementById('security-modal').classList.add('hidden'); showPrompt(activeTab()); }
function proceedDangerCmd() {
  const modal = document.getElementById('security-modal');
  const cmd   = modal.dataset.pendingCmd;
  modal.classList.add('hidden');
  if (cmd) executeCommand(activeTab(), cmd);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function demoBrowser(tab, cmd) {
  const DEMO = {
    'pwd':   '/home/termai',
    'whoami':'termai',
    'date':  new Date().toString(),
    'ls':    'Documents  Downloads  Projects  .config',
    'uname -a': 'Linux termai 5.15 Android aarch64',
    'echo $SHELL': '/bin/sh',
  };
  tab.term.writeln(DEMO[cmd] || `\x1b[33m[Demo] Command: ${escHtml(cmd)}\x1b[0m`);
  tab.isRunning = false;
  showPrompt(tab);
}

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Apply saved theme
  if (state.theme !== 'dark') applyTheme(state.theme);

  // Check premium
  const isPro = Native.billing()?.getPremiumStatus?.() === 'active';
  AI.isPremium = isPro;
  updateAIBadge(false);
  updatePremiumBadge(isPro);

  // Android keyboard fix — setup once
  const kbInput = document.getElementById('kb-input');
  if (kbInput) {
    document.getElementById('terminal-container').addEventListener('click', () => {
      kbInput.focus();
    });
    kbInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (!val) return;
      const tab = activeTab();
      if (!tab) return;
      for (const ch of val) {
        tab.inputBuffer += ch;
        tab.term.write(ch);
      }
      kbInput.value = '';
    });
    kbInput.addEventListener('keydown', (e) => {
      const tab = activeTab();
      if (!tab) return;
      if (e.key === 'Enter')          { handleEnter(tab);    e.preventDefault(); }
      else if (e.key === 'Backspace') { handleBackspace(tab); e.preventDefault(); }
      else if (e.key === 'ArrowUp')   { navigateHistory(tab, -1); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { navigateHistory(tab,  1); e.preventDefault(); }
      else if (e.key === 'Tab')       { handleTabComplete(tab);   e.preventDefault(); }
    });
  }

  // Create first tab
  createTab('Shell 1');

  // Back button
  document.addEventListener('backbutton', e => {
    e.preventDefault();
    if (state.isSleeping) { wakeUp(); return; }
    const aiPanel  = document.getElementById('ai-panel');
    const settings = document.getElementById('settings-overlay');
    const secModal = document.getElementById('security-modal');
    if (!secModal.classList.contains('hidden')) { cancelDangerCmd(); return; }
    if (!aiPanel.classList.contains('hidden'))  { closeAIPanel(); return; }
    if (!settings.classList.contains('hidden')) { closeSettings(); return; }
  });

  // Click on terminal container = focus
  document.getElementById('terminal-container').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    activeTab()?.term.focus();
  });

  // Test AI connection after load
  setTimeout(() => AI.testConnection(), 2500);
});
