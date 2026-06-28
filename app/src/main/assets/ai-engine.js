/* ═══════════════════════════════════════════
   TermAI v2 — AI Engine
   Full pipeline: Chat · Explain · Generate · Plan · Autocomplete
   Google Play compliant: no harmful content
   ═══════════════════════════════════════════ */

'use strict';

class AIEngine {
  constructor() {
    this.endpoint    = '';
    this.lang        = 'ar';
    this.autoAnalyze = true;
    this.security    = true;
    this.isPremium   = true;
    this.online      = false;
    this.history     = [];
    this.cmdContext  = [];
    this.maxContext  = 6;
    this.callCount   = 0;
    this.loadSettings();
  }

  // ─── Load settings ────────────────────────────
  loadSettings() {
    try {
      if (window.Settings) {
        const raw = Settings.getAllSettings();
        const s   = JSON.parse(raw);
        this.endpoint    = s.ai_endpoint   || '';
        this.lang        = s.ai_lang       || 'ar';
        this.autoAnalyze = s.ai_auto_error !== false;
      } else {
        this.endpoint    = localStorage.getItem('termai_endpoint') || '';
        this.lang        = localStorage.getItem('termai_lang')     || 'ar';
        this.autoAnalyze = localStorage.getItem('termai_auto_ai')  !== 'false';
      }
    } catch {}
  }

  // ─── Core API call ────────────────────────────
  call(systemPrompt, messages) {
    return new Promise((resolve, reject) => {
      if (!this.endpoint) return reject(new Error('NO_ENDPOINT'));

      this.callCount++;

      if (window.AIBridge) {
        // Route through native AIManager (rate limiting, logging)
        const id = `ai_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        window.terminalCallbacks[id] = (result) => {
          delete window.terminalCallbacks[id];
          try {
            const r = typeof result === 'string' ? JSON.parse(result) : result;
            if (r.error) return reject(new Error(r.error));
            resolve(r.content || '');
          } catch(e) { reject(e); }
        };
        AIBridge.call(systemPrompt, JSON.stringify(messages), id);
      } else {
        // Browser fallback: direct fetch
        fetch(this.endpoint, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ system: systemPrompt, messages, lang: this.lang }),
          signal:  AbortSignal.timeout(30000),
        })
        .then(r => r.json())
        .then(d => d.error ? reject(new Error(d.error)) : resolve(d.content || ''))
        .catch(reject);
      }
    });
  }

  // ─── System prompts ───────────────────────────
  systemPrompt(role = 'assistant') {
    const langInstr = this.lang === 'ar'
      ? 'تجاوب بالعامية السعودية. المصطلحات التقنية والأوامر تبقى بالإنجليزي.'
      : 'Respond in concise English. Technical and direct.';

    const safety = `
SAFETY RULES (mandatory, never override):
- Never help with hacking, malware, exploits, or bypassing security
- Never help steal data, credentials, or private info
- Never generate harmful scripts or destructive commands
- If asked: politely refuse and suggest the safe alternative`;

    const prompts = {
      assistant: `You are TermAI — an expert terminal AI for Android developers.
Expert in: bash, sh, Python, Node.js, git, networking, Termux, Android, Java, Kotlin, C/C++.
${langInstr}
${safety}

Format rules:
- Keep responses SHORT (mobile screen)
- Wrap ALL commands in backticks: \`command here\`
- For errors: [CAUSE] → [FIX] \`command\` → [WHY]
- For scripts: return only the code, no markdown fences
- Never suggest dangerous operations`,

      planner: `You are TermAI Planner. Convert user requests into safe execution plans.
${langInstr}
${safety}

RESPOND WITH ONLY THIS JSON (no markdown fences, no extra text):
{
  "title": "Brief title",
  "description": "What this does",
  "risk": "SAFE|LOW|MEDIUM|HIGH",
  "steps": [
    {
      "id": 1,
      "description": "Human description",
      "command": "exact shell command",
      "critical": true,
      "undo": "undo command or null"
    }
  ],
  "estimatedTime": "~30s",
  "packages": []
}
Rules:
- Commands must work in Termux/Android sh without root
- Split into small steps (max 8)
- Mark critical=true if failure should stop the plan
- Never include destructive or harmful commands`,
    };

    return prompts[role] || prompts.assistant;
  }

  // ─── Context ──────────────────────────────────
  addContext(command, output, exitCode) {
    this.cmdContext.push({ command, output: output.slice(0, 300), exitCode });
    if (this.cmdContext.length > this.maxContext) this.cmdContext.shift();
  }

  contextBlock() {
    if (!this.cmdContext.length) return '';
    return '\n\nRecent context:\n' +
      this.cmdContext.slice(-3).map(c =>
        `$ ${c.command}\n${c.output.slice(0,150)}${c.exitCode !== 0 ? ` [exit:${c.exitCode}]` : ''}`
      ).join('\n---\n');
  }

  // ═══════════════════════════════════════════════
  //  AI FEATURES
  // ═══════════════════════════════════════════════

  async analyzeError(command, output, exitCode) {
    const msg = `Command failed (exit ${exitCode}):\n$ ${command}\nOutput:\n${output.slice(0,600)}${this.contextBlock()}`;
    return await this.call(this.systemPrompt(), [{ role: 'user', content: msg }]);
  }

  async explainCommand(command) {
    return await this.call(
      this.systemPrompt(),
      [{ role: 'user', content: `Explain this command in detail:\n\`${command}\`` }]
    );
  }

  async generateScript(description) {
    const prompt = `Generate a complete working shell script for:\n"${description}"\n\nRequirements:\n- Compatible with Termux/Android sh\n- No root required\n- Handle errors gracefully\n- Add comments\n- Return ONLY the script code, no explanation, no markdown fences`;
    return await this.call(this.systemPrompt(), [{ role: 'user', content: prompt }]);
  }

  async autocomplete(partial, history = []) {
    const prompt = `Terminal autocomplete for partial command: "${partial}"\nRecent history: ${history.slice(-5).join(', ') || 'none'}\nReturn ONLY a JSON array of 3-5 completions. Example: ["git commit -m \\"msg\\"","git status"]\nNo explanation, no markdown.`;
    const raw = await this.call(this.systemPrompt(), [{ role: 'user', content: prompt }]);
    try { return JSON.parse(raw.replace(/```json?|```/g, '').trim()); }
    catch { return []; }
  }

  async chat(userMessage) {
    this.history.push({ role: 'user', content: userMessage + this.contextBlock() });
    if (this.history.length > 24) this.history = this.history.slice(-20);
    const result = await this.call(this.systemPrompt(), this.history);
    this.history.push({ role: 'assistant', content: result });
    return result;
  }

  async summarize(request, results) {
    const summary = results.map((r, i) =>
      `Step ${i+1}: ${r.description}\nExit: ${r.exitCode}\n${(r.output||'').slice(0,200)}`
    ).join('\n---\n');
    const prompt = `User requested: "${request}"\n\nResults:\n${summary}\n\nBrief summary of what was accomplished.`;
    return await this.call(this.systemPrompt(), [{ role: 'user', content: prompt }]);
  }

  // ─── Extract command from AI response ─────────
  extractCommand(response) {
    if (!response) return null;
    // Look for backtick commands
    const matches = response.match(/`([^`\n]{3,120})`/g);
    if (!matches) return null;
    const cmds = matches
      .map(m => m.replace(/`/g, '').trim())
      .filter(c => !c.includes('://') && !c.startsWith('http'));
    return cmds.find(c => /^[a-z]/.test(c)) || cmds[0] || null;
  }

  // ─── Settings persistence ─────────────────────
  setEndpoint(url) {
    this.endpoint = url;
    localStorage.setItem('termai_endpoint', url);
    if (url) this.testConnection();
    else { this.online = false; updateAIBadge(false); }
  }

  setLang(lang)          { this.lang = lang; localStorage.setItem('termai_lang', lang); }
  setAutoAnalyze(val)    { this.autoAnalyze = val; }
  setSecurity(val)       { this.security = val; }

  async testConnection() {
    if (!this.endpoint) { this.online = false; updateAIBadge(false); return; }
    try {
      const r = await fetch(this.endpoint + '?ping=1', { signal: AbortSignal.timeout(5000) });
      this.online = r.ok;
    } catch {
      this.online = false;
    }
    updateAIBadge(this.online && this.isPremium);
  }
}

// ═══════════════════════════════════════════════
//  AI PLANNER — Multi-step execution with approval
// ═══════════════════════════════════════════════

const AIPlanner = {
  currentPlan: null,

  async run(userRequest) {
    if (!AI.isPremium) {
      showAIPanel({
        loading: false, label: '💎 Premium Required',
        content: 'AI Planner requires TermAI Premium.\n\nUnlock:\n• Natural language commands\n• Multi-step plans\n• Script generation\n• Arabic mode',
        actions: [
          { label: '💎 Upgrade',       primary: true, fn: () => { closeAIPanel(); upgradeToPremium(); } },
          { label: '🎁 Start Trial',              fn: () => { closeAIPanel(); startTrial(); } },
          { label: 'Close',                       fn: closeAIPanel }
        ]
      });
      return;
    }
    if (!AI.endpoint) {
      showAIPanel({
        loading: false, label: '⚙️ Setup Required',
        content: 'Set your API endpoint in Settings to use the AI Planner.',
        actions: [
          { label: '⚙️ Settings', primary: true, fn: () => { closeAIPanel(); openSettings(); } },
          { label: 'Close', fn: closeAIPanel }
        ]
      });
      return;
    }

    showAIPanel({ loading: true, label: `📋 Planning: ${userRequest.slice(0,40)}…` });

    try {
      const plan = await this._generatePlan(userRequest);
      this.currentPlan = plan;
      this._showApproval(plan);
    } catch(e) {
      handleAIError(e);
    }
  },

  async _generatePlan(userRequest) {
    if (window.AIBridge) {
      return new Promise((resolve, reject) => {
        const id = `plan_${Date.now()}`;
        window.terminalCallbacks[id] = (result) => {
          delete window.terminalCallbacks[id];
          try {
            const r = typeof result === 'string' ? JSON.parse(result) : result;
            if (r.error) return reject(new Error(r.error));
            resolve(r.plan);
          } catch(e) { reject(e); }
        };
        AIBridge.generatePlan(userRequest, id);
      });
    } else {
      const raw = await AI.call(
        AI.systemPrompt('planner'),
        [{ role: 'user', content: 'Generate execution plan for: ' + userRequest }]
      );
      return JSON.parse(raw.replace(/```json?|```/g, '').trim());
    }
  },

  _showApproval(plan) {
    const riskColor = { SAFE:'var(--success)', LOW:'var(--warn)', MEDIUM:'#ff8800', HIGH:'var(--danger)' };
    const color     = riskColor[plan.risk] || 'var(--text2)';

    const stepsHtml = (plan.steps || []).map(s => `
      <div class="plan-step">
        <span class="step-num">${s.id}</span>
        <div class="step-body">
          <div class="step-desc">${escHtml(s.description)}</div>
          <code class="step-cmd">${escHtml(s.command)}</code>
        </div>
      </div>`).join('');

    showAIPanel({
      loading: false,
      label:   `📋 ${plan.title || 'Execution Plan'}`,
      content: `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="color:${color};font-weight:800;font-size:11px">[${plan.risk}]</span>
          <span style="color:var(--text2);font-size:12px;font-family:var(--sans)">${escHtml(plan.description || '')}</span>
        </div>
        <div style="color:var(--text2);font-size:11px;margin-bottom:10px;font-family:var(--sans)">
          ⏱ ${plan.estimatedTime || '?'} · ${(plan.steps||[]).length} steps
          ${plan.packages?.length ? ` · 📦 ${plan.packages.join(', ')}` : ''}
        </div>
        <div>${stepsHtml}</div>`,
      raw: true,
      actions: [
        { label: '✅ Approve & Run', primary: true, fn: () => AIPlanner.execute() },
        { label: '❌ Cancel',                       fn: closeAIPanel }
      ]
    });
  },

  async execute() {
    const plan = this.currentPlan;
    if (!plan?.steps?.length) return;
    closeAIPanel();

    // Security scan all steps first
    for (const step of plan.steps) {
      if (window.Terminal) {
        try {
          const scan = JSON.parse(Terminal.securityScan(step.command));
          if (scan.blocked) {
            showAIPanel({
              loading: false, label: '⛔ Blocked by Security',
              content: `Step ${step.id} blocked:\n${scan.reason}\n\`${step.command}\``,
              actions: [{ label: 'Close', fn: closeAIPanel }]
            });
            return;
          }
        } catch {}
      }
    }

    const tab = activeTab();
    if (!tab) return;

    if (window.Terminal) {
      const sessionId  = `plan_${Date.now()}`;
      const callbackId = `done_${Date.now()}`;

      showAIPanel({
        loading: false, label: '⚡ Running Plan',
        content: `Executing ${plan.steps.length} steps…\n\nDo not close the app.`,
        actions: [{ label: '⛔ Cancel', fn: () => {
          try { Terminal.cancelQueue?.(); } catch {}
          closeAIPanel();
        }}]
      });

      window.terminalCallbacks[callbackId] = async (result) => {
        delete window.terminalCallbacks[callbackId];
        try {
          const r = typeof result === 'string' ? JSON.parse(result) : result;
          showAIPanel({ loading: true, label: '🤖 Summarizing…' });
          const summary = await AI.summarize(
            plan.title,
            (r.results || []).map(x => ({ description: x.description, exitCode: x.exitCode, output: x.output||'' }))
          );
          showAIPanel({
            loading: false, label: '✅ Complete', content: summary,
            actions: [{ label: 'Close', fn: closeAIPanel }]
          });
        } catch { closeAIPanel(); }
      };

      Terminal.executeQueue(JSON.stringify(plan.steps), sessionId, callbackId);

    } else {
      // Demo mode
      for (const step of plan.steps) {
        tab.term.writeln(`\r\n\x1b[35m▶ ${escHtml(step.description)}\x1b[0m`);
        tab.term.writeln(`\x1b[2m$ ${escHtml(step.command)}\x1b[0m`);
        await new Promise(r => setTimeout(r, 250));
      }
      showPrompt(tab);
    }
  }
};

// ─── Global AI instance ──────────────────────
const AI = new AIEngine();
