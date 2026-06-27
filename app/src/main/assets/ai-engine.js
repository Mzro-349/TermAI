/* ═══════════════════════════════════════════
   TermAI — AI Engine v2
   Full Pipeline: User → Planner → Security → Approval → Execute → Summary
   ═══════════════════════════════════════════ */

class AIEngine {
  constructor() {
    this.endpoint    = '';
    this.lang        = 'ar';
    this.autoAnalyze = true;
    this.security    = true;
    this.isPremium   = false;
    this.online      = false;
    this.history     = [];
    this.cmdContext  = [];
    this.maxContext  = 8;
    this.loadSettings();
  }

  // ─── Load from SettingsManager ────────────────
  loadSettings() {
    try {
      if (window.Settings) {
        const raw  = Settings.getAllSettings();
        const s    = JSON.parse(raw);
        this.endpoint    = s.ai_endpoint   || '';
        this.lang        = s.ai_lang       || 'ar';
        this.autoAnalyze = s.ai_auto_error !== false;
      } else {
        this.endpoint    = localStorage.getItem('termai_endpoint') || '';
        this.lang        = localStorage.getItem('termai_lang')     || 'ar';
        this.autoAnalyze = localStorage.getItem('termai_auto_ai')  !== 'false';
      }
    } catch(e) {}
  }

  // ─── Core API call (via Android AIBridge) ─────
  call(systemPrompt, messages) {
    return new Promise((resolve, reject) => {
      if (!this.endpoint) return reject(new Error('NO_ENDPOINT'));
      if (!this.isPremium) return reject(new Error('NOT_PREMIUM'));

      if (window.AIBridge) {
        // Route through native AIManager (rate limiting, logging, secure)
        const id = `ai_${Date.now()}`;
        window.terminalCallbacks[id] = (result) => {
          delete window.terminalCallbacks[id];
          const r = typeof result === 'string' ? JSON.parse(result) : result;
          if (r.error) return reject(new Error(r.error));
          resolve(r.content || '');
        };
        AIBridge.call(systemPrompt, JSON.stringify(messages), id);
      } else {
        // Browser fallback: direct fetch
        fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system: systemPrompt, messages, lang: this.lang })
        })
        .then(r => r.json())
        .then(d => d.error ? reject(new Error(d.error)) : resolve(d.content || ''))
        .catch(reject);
      }
    });
  }

  // ─── System Prompt ────────────────────────────
  buildSystemPrompt(role = 'assistant') {
    const langInstr = this.lang === 'ar'
      ? 'Respond ENTIRELY in Saudi Arabic dialect (عامية سعودية). Technical terms/commands stay in English.'
      : 'Respond in English. Be concise and technical.';

    const prompts = {
      assistant: `You are TermAI — an elite terminal AI for Android.
Expert in: bash, Python, Node.js, git, networking, security, Termux, Android development.
${langInstr}
Rules:
- Keep responses SHORT (mobile screen)
- Format fix commands in backticks always
- For errors: [CAUSE] then [FIX] \`command\` then [WHY]
- Never refuse — always suggest best available alternative
- Security-conscious: warn about dangerous operations`,

      planner: `You are TermAI Planner. Convert requests to structured execution plans.
${langInstr}
RESPOND WITH ONLY THIS JSON (no markdown fences):
{
  "title": "Brief title",
  "description": "What this plan does",
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
Rules: commands must work in Termux/Android shell without root. Split into small steps.`,
    };
    return prompts[role] || prompts.assistant;
  }

  // ─── Context helpers ──────────────────────────
  addContext(command, output, exitCode) {
    this.cmdContext.push({ command, output: output.slice(0, 400), exitCode });
    if (this.cmdContext.length > this.maxContext) this.cmdContext.shift();
  }

  buildContextBlock() {
    if (!this.cmdContext.length) return '';
    return '\n\nRecent terminal context:\n' +
      this.cmdContext.slice(-3).map(c =>
        `$ ${c.command}\n${c.output.slice(0,200)}${c.exitCode !== 0 ? ` [exit:${c.exitCode}]` : ''}`
      ).join('\n---\n');
  }

  // ═══════════════════════════════════════════════
  // AI Features
  // ═══════════════════════════════════════════════

  // ─── Error analysis ───────────────────────────
  async analyzeError(command, output, exitCode) {
    const msg = `Command failed (exit ${exitCode}):\n$ ${command}\nOutput:\n${output.slice(0,800)}${this.buildContextBlock()}`;
    return await this.call(this.buildSystemPrompt(), [{ role:'user', content:msg }]);
  }

  // ─── Explain command ──────────────────────────
  async explainCommand(command) {
    return await this.call(
      this.buildSystemPrompt(),
      [{ role:'user', content:`Explain this command: \`${command}\`` }]
    );
  }

  // ─── Generate script ──────────────────────────
  async generateScript(description) {
    const prompt = `Generate a complete working bash script for: ${description}
Requirements: Termux/Android compatible, no root, handle errors, add comments.
Return ONLY the script code — no markdown fences, no explanation.`;
    return await this.call(this.buildSystemPrompt(), [{ role:'user', content:prompt }]);
  }

  // ─── Smart autocomplete ───────────────────────
  async autocomplete(partial, history = []) {
    const prompt = `Terminal autocomplete. Partial: "${partial}"
Recent history: ${history.slice(-5).join(', ')||'none'}
Return ONLY a JSON array of 3-5 completions, nothing else.
Example: ["git commit -m \\"msg\\"","git config --global user.name"]`;
    const raw  = await this.call(this.buildSystemPrompt(), [{ role:'user', content:prompt }]);
    try { return JSON.parse(raw.replace(/```json?|```/g,'').trim()); }
    catch { return []; }
  }

  // ─── Chat ─────────────────────────────────────
  async chat(userMessage) {
    this.history.push({ role:'user', content: userMessage + this.buildContextBlock() });
    const result = await this.call(this.buildSystemPrompt(), this.history);
    this.history.push({ role:'assistant', content: result });
    if (this.history.length > 20) this.history = this.history.slice(-16);
    return result;
  }

  // ─── AI summarize (post-execution) ───────────
  async summarize(request, results) {
    const summary = results.map((r,i) =>
      `Step ${i+1}: ${r.description}\nExit: ${r.exitCode}\n${r.output.slice(0,200)}`
    ).join('\n---\n');
    const prompt = `User requested: "${request}"\n\nExecution results:\n${summary}\n\nProvide a brief summary of what was accomplished and any issues.`;
    return await this.call(this.buildSystemPrompt(), [{ role:'user', content:prompt }]);
  }

  // ═══════════════════════════════════════════════
  // PLANNER — Full AI execution flow
  // ═══════════════════════════════════════════════
  async generatePlan(userRequest) {
    if (window.AIBridge) {
      // Use native AIManager.generatePlan() (has better prompting + logging)
      return new Promise((resolve, reject) => {
        const id = `plan_${Date.now()}`;
        window.terminalCallbacks[id] = (result) => {
          delete window.terminalCallbacks[id];
          const r = typeof result === 'string' ? JSON.parse(result) : result;
          if (r.error) return reject(new Error(r.error));
          resolve(r.plan);
        };
        AIBridge.generatePlan(userRequest, id);
      });
    } else {
      // Browser fallback
      const raw = await this.call(this.buildSystemPrompt('planner'),
        [{ role:'user', content:'Generate execution plan for: ' + userRequest }]);
      return JSON.parse(raw.replace(/```json?|```/g,'').trim());
    }
  }

  // ─── Extract fix command from AI response ─────
  extractFixCommand(response) {
    const matches = response.match(/`([^`\n]{3,80})`/g);
    if (!matches) return null;
    const cmds = matches.map(m => m.replace(/`/g,'').trim());
    return cmds.find(c => !c.includes('://') && c.split(' ').length >= 1) || cmds[0];
  }

  // ─── Settings persistence ─────────────────────
  setEndpoint(url) {
    this.endpoint = url;
    if (window.Settings) Settings.setString('ai_endpoint', url);
    else localStorage.setItem('termai_endpoint', url);
    this.testConnection();
  }

  setLang(lang) {
    this.lang = lang;
    if (window.Settings) Settings.setString('ai_lang', lang);
    else localStorage.setItem('termai_lang', lang);
  }

  setAutoAnalyze(val) {
    this.autoAnalyze = val;
    if (window.Settings) Settings.setBool('ai_auto_error', val);
  }

  setSecurity(val) {
    this.security = val;
  }

  async testConnection() {
    if (!this.endpoint) { this.online = false; updateAIBadge(false); return; }
    try {
      const r = await fetch(this.endpoint + '?ping=1', { signal: AbortSignal.timeout(5000) });
      this.online = r.ok;
    } catch { this.online = false; }
    updateAIBadge(this.online && this.isPremium);
  }
}

// ═══════════════════════════════════════════════
// AI Planner UI — Full flow with approval
// ═══════════════════════════════════════════════
const AIPlanner = {

  currentPlan: null,

  // Entry point: user types natural language request
  async run(userRequest) {
    if (!AI.isPremium) { showAIPremiumGate(); return; }
    if (!AI.endpoint)  { showAISetupGate();   return; }

    showPlannerLoading(userRequest);

    try {
      const plan = await AI.generatePlan(userRequest);
      this.currentPlan = plan;
      this.showApproval(plan);
    } catch(e) {
      closePlanner();
      handleAIError(e);
    }
  },

  // Show plan to user before any execution
  showApproval(plan) {
    const riskColor = { SAFE:'#00e676', LOW:'#ffaa00', MEDIUM:'#ff8800', HIGH:'#ff4444' };
    const color     = riskColor[plan.risk] || '#888';

    const stepsHtml = (plan.steps || []).map(s => `
      <div class="plan-step">
        <span class="step-num">${s.id}</span>
        <div class="step-body">
          <div class="step-desc">${s.description}</div>
          <code class="step-cmd">${s.command}</code>
        </div>
      </div>`).join('');

    showAIPanel({
      loading: false,
      label: `📋 ${plan.title || 'Execution Plan'}`,
      content: `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="color:${color};font-weight:700;font-size:11px">[${plan.risk}]</span>
          <span style="color:var(--text2);font-size:12px">${plan.description}</span>
        </div>
        <div style="color:var(--text2);font-size:11px;margin-bottom:8px">
          ⏱ ${plan.estimatedTime || 'unknown'} · ${(plan.steps||[]).length} steps
        </div>
        <div id="plan-steps">${stepsHtml}</div>
        ${plan.packages?.length
          ? `<div style="margin-top:8px;color:var(--text2);font-size:11px">📦 Packages: ${plan.packages.join(', ')}</div>`
          : ''}`,
      actions: [
        { label: '✅ Approve & Run', primary: true, onclick: 'AIPlanner.execute()' },
        { label: '❌ Cancel',                       onclick: 'closeAIPanel()' }
      ]
    });
  },

  // Execute approved plan
  async execute() {
    const plan = this.currentPlan;
    if (!plan || !plan.steps?.length) return;
    closeAIPanel();

    // Security scan each step first
    for (const step of plan.steps) {
      const scanRaw = window.Terminal ? Terminal.securityScan(step.command) : '{"safe":true}';
      const scan    = JSON.parse(scanRaw);
      if (scan.blocked) {
        showAIPanel({ loading:false, label:'⛔ Security Block',
          content: `Step ${step.id} blocked:\n${scan.reason}\n\`${step.command}\``,
          actions:[{label:'Close',onclick:'closeAIPanel()'}] });
        return;
      }
    }

    const tab = getActiveTab();
    if (!tab) return;

    if (window.Terminal) {
      // Native queue execution
      const sessionId  = `plan_${Date.now()}`;
      const callbackId = `done_${Date.now()}`;

      showQueueProgress(plan);

      window.terminalCallbacks[callbackId] = async (result) => {
        delete window.terminalCallbacks[callbackId];
        const r = typeof result === 'string' ? JSON.parse(result) : result;
        const results = r.results || [];

        // AI summary
        try {
          showAIPanel({ loading:true, label:'🤖 Summarizing...' });
          const summary = await AI.summarize(
            plan.title, results.map(x => ({ description:x.description, exitCode:x.exitCode, output:x.output||'' })));
          showAIPanel({ loading:false, label:'✅ Complete',
            content: summary,
            actions:[{label:'Close',onclick:'closeAIPanel()'}]
          });
        } catch(e) {
          closeAIPanel();
        }
      };

      Terminal.executeQueue(JSON.stringify(plan.steps), sessionId, callbackId);

    } else {
      // Demo mode: simulate
      for (const step of plan.steps) {
        tab.term.writeln(`\r\n\x1b[35m▶ ${step.description}\x1b[0m`);
        tab.term.writeln(`$ ${step.command}`);
        await new Promise(r => setTimeout(r, 300));
      }
      showPrompt(tab);
    }
  }
};

function showPlannerLoading(request) {
  showAIPanel({ loading:true, label:`📋 Planning: ${request.slice(0,40)}…` });
}

function showQueueProgress(plan) {
  showAIPanel({
    loading: false,
    label:   '⚡ Executing Plan',
    content: `Running ${plan.steps.length} steps…\n\nYou can cancel at any time.`,
    actions: [{ label:'⛔ Cancel', onclick:'Terminal.cancelQueue&&Terminal.cancelQueue()' }]
  });
}

function showAIPremiumGate() {
  showAIPanel({ loading:false, label:'💎 Premium Required',
    content:'AI planning requires TermAI Premium.\n\nUpgrade to unlock:\n• Natural language commands\n• Smart error analysis\n• Script generation\n• Arabic mode',
    actions:[
      {label:'💎 Upgrade', primary:true, onclick:'upgradeToPremium()'},
      {label:'🆓 Start Trial', onclick:'startTrial()'},
      {label:'Close', onclick:'closeAIPanel()'}
    ]
  });
}

function showAISetupGate() {
  showAIPanel({ loading:false, label:'⚙️ Setup Required',
    content:'Set your API endpoint in Settings to enable AI features.',
    actions:[
      {label:'⚙️ Settings', primary:true, onclick:'openSettings()'},
      {label:'Close', onclick:'closeAIPanel()'}
    ]
  });
}

function startTrial() {
  if (window.Billing) {
    const r = JSON.parse(Billing.startTrial());
    if (r.ok) {
      AI.isPremium = true;
      updateAIBadge(true);
      showToast('🎉 7-day trial started!');
      closeAIPanel();
    } else {
      showToast(r.reason || 'Trial not available');
    }
  }
}

// ─── Global AI instance ──────────────────────
const AI = new AIEngine();
setTimeout(() => AI.testConnection(), 2000);
