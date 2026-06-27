// TermAI — Vercel API Proxy
// Deploy to: https://your-app.vercel.app/api/ai

const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX    = 30;     // requests per window
const rateLimitMap      = new Map();

// Simple in-memory rate limiter
function checkRateLimit(ip) {
  const now    = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now - record.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) return false;
  record.count++;
  return true;
}

// Clean old entries periodically
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  for (const [k, v] of rateLimitMap) {
    if (v.start < cutoff) rateLimitMap.delete(k);
  }
}, 120_000);

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Ping check
  if (req.method === 'GET' && req.query.ping) {
    return res.status(200).json({ ok: true, service: 'TermAI API' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Slow down.' });
  }

  const { messages, system, lang } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Validate messages
  for (const m of messages) {
    if (!m.role || !m.content) return res.status(400).json({ error: 'Invalid message format' });
    if (!['user', 'assistant'].includes(m.role)) return res.status(400).json({ error: 'Invalid role' });
    if (typeof m.content !== 'string') return res.status(400).json({ error: 'Content must be string' });
    if (m.content.length > 8000) return res.status(400).json({ error: 'Message too long' });
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            API_KEY,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1000,
        system:     system || buildDefaultSystem(lang),
        messages:   messages.map(m => ({
          role:    m.role,
          content: m.content.slice(0, 8000), // safety truncation
        })),
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('Anthropic error:', err);
      return res.status(response.status).json({
        error: err.error?.message || `Anthropic API error ${response.status}`
      });
    }

    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';

    return res.status(200).json({ content: text });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function buildDefaultSystem(lang) {
  const isArabic = lang === 'ar';
  return `You are TermAI, an expert terminal assistant for Android/Linux.
${isArabic
  ? 'Respond in Saudi Arabic dialect (عامية سعودية). Use English only for technical terms like commands and code.'
  : 'Respond in English. Be technical and concise.'}
You specialize in: bash, shell scripting, Termux, Android, git, networking, security, and system administration.
Always be direct. Format fix commands in backticks. Keep responses short for mobile screens.`;
}
