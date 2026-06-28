'use strict';

// ─── State ───────────────────────────────────
const S = {
  tabs: [], activeTab: 0, tabCount: 0,
  history: JSON.parse(localStorage.getItem('hist') || '[]'),
  histIdx: -1, curInput: '',
  endpoint: localStorage.getItem('endpoint') || '',
  lang: localStorage.getItem('lang') || 'ar',
  fontSize: parseInt(localStorage.getItem('fs')) || 14,
  theme: localStorage.getItem('theme') || 'dark',
};

// ─── Init ────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  applyTheme(S.theme);
  applyFontSize(S.fontSize);
  document.getElementById('set-endpoint').value = S.endpoint;
  document.getElementById('set-lang').value = S.lang;
  document.getElementById('set-fontsize').value = S.fontSize;
  document.getElementById('font-size-val').textContent = S.fontSize;
  document.getElementById('set-theme').value = S.theme;

  addTab();

  const input = document.getElementById('cmd-input');
  input.addEventListener('keydown', onKeyDown);
  input.focus();

  document.getElementById('ai-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendAI();
  });
});

// ─── Tabs ─────────────────────────────────────
function addTab() {
  const id = ++S.tabCount;
  const tab = { id, name: `Shell ${id}`, lines: [], cwd: '~' };
  S.tabs.push(tab);
  switchTab(id);
  renderTabs();
  printWelcome();
}

function switchTab(id) {
  S.activeTab = id;
  renderTabs();
  renderOutput();
  updatePrompt();
  focusInput();
}

function closeTab(id, e) {
  e.stopPropagation();
  if (S.tabs.length === 1) return;
  S.tabs = S.tabs.filter(t => t.id !== id);
  if (S.activeTab === id) switchTab(S.tabs[S.tabs.length - 1].id);
  else renderTabs();
}

function renderTabs() {
  document.getElementById('tabs-list').innerHTML = S.tabs.map(t => `
    <div class="tab ${t.id === S.activeTab ? 'active' : ''}" onclick="switchTab(${t.id})">
      ● ${t.name}
      ${S.tabs.length > 1 ? `<span class="tab-close" onclick="closeTab(${t.id},event)">✕</span>` : ''}
    </div>`).join('');
}

function getTab() { return S.tabs.find(t => t.id === S.activeTab); }

// ─── Output ───────────────────────────────────
function print(text, cls = 'line-output') {
  const tab = getTab();
  if (!tab) return;
  tab.lines.push({ text, cls });
  if (tab.id === S.activeTab) appendLine(text, cls);
}

function appendLine(text, cls) {
  const el = document.getElementById('terminal-output');
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function renderOutput() {
  const el = document.getElementById('terminal-output');
  el.innerHTML = '';
  const tab = getTab();
  if (!tab) return;
  tab.lines.forEach(l => appendLine(l.text, l.cls));
}

function printWelcome() {
  print('╔══════════════════════════╗', 'line-info');
  print('║  ⚡ TermAI  v2.0        ║', 'line-info');
  print('║  اكتب !help للمساعدة    ║', 'line-info');
  print('╚══════════════════════════╝', 'line-info');
}

// ─── Input ────────────────────────────────────
function focusInput() {
  document.getElementById('cmd-input').focus();
}

function onKeyDown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const input = document.getElementById('cmd-input');
    const cmd = input.value.trim();
    input.value = '';
    if (cmd) runCommand(cmd);
    else print('');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault(); historyUp();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault(); historyDown();
  } else if (e.key === 'Tab') {
    e.preventDefault(); sendTab();
  }
}

function insertChar(c) {
  const input = document.getElementById('cmd-input');
  const pos = input.selectionStart;
  input.value = input.value.slice(0, pos) + c + input.value.slice(pos);
  input.selectionStart = input.selectionEnd = pos + c.length;
  input.focus();
}

function sendCtrl(key) {
  if (key === 'c') {
    const input = document.getElementById('cmd-input');
    const cmd = input.value;
    input.value = '';
    const tab = getTab();
    print((tab ? tab.cwd : '~') + ' ❯ ' + cmd + '^C', 'line-prompt');
    if (window.Terminal) try { Terminal.interrupt(); } catch {}
  } else if (key === 'l') {
    const tab = getTab();
    if (tab) tab.lines = [];
    document.getElementById('terminal-output').innerHTML = '';
  }
}

function sendTab() {
  const input = document.getElementById('cmd-input');
  const val = input.value;
  if (!val || !window.Terminal) return;
  try {
    const result = Terminal.requestCompletion(val);
    if (result) {
      const completions = JSON.parse(result);
      if (completions.length === 1) {
        input.value = completions[0];
      } else if (completions.length > 1) {
        print(completions.join('  '), 'line-info');
      }
    }
  } catch {}
}

// ─── History ──────────────────────────────────
function historyUp() {
  const input = document.getElementById('cmd-input');
  if (S.histIdx === -1) S.curInput = input.value;
  if (S.histIdx < S.history.length - 1) {
    S.histIdx++;
    input.value = S.history[S.history.length - 1 - S.histIdx];
  }
}

function historyDown() {
  const input = document.getElementById('cmd-input');
  if (S.histIdx > 0) {
    S.histIdx--;
    input.value = S.history[S.history.length - 1 - S.histIdx];
  } else {
    S.histIdx = -1;
    input.value = S.curInput;
  }
}

function addHistory(cmd) {
  if (!cmd || S.history[S.history.length - 1] === cmd) return;
  S.history.push(cmd);
  if (S.history.length > 500) S.history.shift();
  localStorage.setItem('hist', JSON.stringify(S.history.slice(-200)));
}

// ─── Command Execution ────────────────────────
async function runCommand(cmd) {
  const tab = getTab();
  const cwd = tab ? tab.cwd : '~';
  S.histIdx = -1;
  addHistory(cmd);
  print(cwd + ' ❯ ' + cmd, 'line-prompt');

  // Built-ins
  if (cmd === 'clear' || cmd === 'cls') {
    if (tab) tab.lines = [];
    document.getElementById('terminal-output').innerHTML = '';
    return;
  }
  if (cmd === '!help') { printHelp(); return; }
  if (cmd.startsWith('!ai ')) { await askAI(cmd.slice(4)); return; }
  if (cmd.startsWith('!explain ')) { await explainCmd(cmd.slice(9)); return; }

  // Execute via native bridge
  if (window.Terminal) {
    try {
      const cbId = 'cb_' + Date.now();
      window.termCb = window.termCb || {};
      window.termCb[cbId] = (result) => {
        delete window.termCb[cbId];
        try {
          const r = JSON.parse(result);
          if (r.output) print(r.output, r.exitCode !== 0 ? 'line-error' : 'line-output');
          if (r.cwd) {
            if (tab) tab.cwd = r.cwd;
            updatePrompt();
          }
        } catch { print(result); }
      };
      Terminal.executeCommand(cmd, 'main', cbId);
    } catch(e) { print('Error: ' + e.message, 'line-error'); }
  } else {
    // Demo mode
    const DEMO = {
      'ls': 'Documents  Downloads  Projects',
      'pwd': '/data/data/com.termai/files/home',
      'whoami': 'termai',
      'date': new Date().toString(),
      'echo hello': 'hello',
    };
    print(DEMO[cmd] || `[Demo] ${cmd}`, 'line-output');
  }
}

function updatePrompt() {
  const tab = getTab();
  const cwd = tab ? tab.cwd : '~';
  document.getElementById('prompt').textContent = cwd + ' ❯ ';
  document.getElementById('pwd-display').textContent = cwd;
}

function printHelp() {
  print('──── أوامر TermAI ────', 'line-info');
  print('!ai <سؤال>      اسأل الذكاء الاصطناعي', 'line-output');
  print('!explain <أمر>  اشرح أمراً', 'line-output');
  print('clear           مسح الشاشة', 'line-output');
  print('↑ ↓             تاريخ الأوامر', 'line-output');
  print('Tab             إكمال تلقائي', 'line-output');
}

// ─── Settings ─────────────────────────────────
function openSettings() {
  document.getElementById('settings-overlay').classList.remove('hidden');
}
function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}
function closeSettingsBg(e) {
  if (e.target.id === 'settings-overlay') closeSettings();
}
function saveSettings() {
  S.endpoint = document.getElementById('set-endpoint').value.trim();
  S.lang     = document.getElementById('set-lang').value;
  localStorage.setItem('endpoint', S.endpoint);
  localStorage.setItem('lang', S.lang);
  if (window.Settings) {
    try {
      Settings.setString('ai_endpoint', S.endpoint);
      Settings.setString('ai_lang', S.lang);
    } catch {}
  }
  closeSettings();
  print('✅ تم حفظ الإعدادات', 'line-info');
}

function changeFontSize(val) {
  S.fontSize = parseInt(val);
  document.getElementById('font-size-val').textContent = val;
  localStorage.setItem('fs', val);
  applyFontSize(S.fontSize);
}

function applyFontSize(size) {
  document.getElementById('terminal-output').style.fontSize = size + 'px';
  document.getElementById('cmd-input').style.fontSize = size + 'px';
  document.getElementById('prompt').style.fontSize = size + 'px';
}

function applyTheme(name) {
  S.theme = name;
  localStorage.setItem('theme', name);
  document.body.className = name !== 'dark' ? 'theme-' + name : '';
}

// ─── AI ───────────────────────────────────────
function openAI() {
  document.getElementById('ai-panel').classList.remove('hidden');
  document.getElementById('ai-input').focus();
}
function closeAI() {
  document.getElementById('ai-panel').classList.add('hidden');
  focusInput();
}

async function sendAI() {
  const input = document.getElementById('ai-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  await askAI(q);
}

async function askAI(question) {
  if (!S.endpoint) {
    document.getElementById('ai-output').textContent = '⚠️ أضف AI Endpoint في الإعدادات';
    openAI();
    return;
  }
  document.getElementById('ai-output').textContent = '⏳ جاري التفكير...';
  openAI();
  try {
    const sys = S.lang === 'ar'
      ? 'أنت مساعد terminal ذكي. تجاوب بالعربية السعودية. الأوامر تبقى بالإنجليزي.'
      : 'You are a smart terminal assistant. Be concise and technical.';
    const res = await fetch(S.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: sys, messages: [{ role: 'user', content: question }] }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await res.json();
    document.getElementById('ai-output').textContent = data.content || data.error || 'لا يوجد رد';
  } catch(e) {
    document.getElementById('ai-output').textContent = '❌ خطأ: ' + e.message;
  }
}

async function explainCmd(cmd) {
  await askAI('اشرح هذا الأمر بالتفصيل: ' + cmd);
}
