'use strict';
/** مساعد البرمجة: توليد بوت كامل + حلقة تصحيح ذاتي. يدعم OpenAI-compatible و Anthropic. */
const PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();
const API_KEY = process.env.AI_API_KEY || '';
const BASE = (process.env.AI_BASE_URL || (PROVIDER === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/$/, '');
const MODEL = process.env.AI_MODEL || (PROVIDER === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o');
const MAX_FIXES = Number(process.env.AI_MAX_FIXES || 4);

const configured = () => Boolean(API_KEY) || /^https?:\/\/(localhost|127\.)/.test(BASE);

async function chat(system, messages) {
  const ctl = AbortSignal.timeout(180000);
  if (PROVIDER === 'anthropic') {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST', signal: ctl,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, system, messages }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`AI ${r.status}: ${j.error?.message || JSON.stringify(j).slice(0, 200)}`);
    return (j.content || []).map((c) => c.text || '').join('');
  }
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', signal: ctl,
    headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`AI ${r.status}: ${j.error?.message || JSON.stringify(j).slice(0, 200)}`);
  return j.choices?.[0]?.message?.content || '';
}

const SYSTEM = (lang) => `You are an expert Telegram bot developer. Write a COMPLETE, working Telegram bot.
Rules:
- Language: ${lang === 'node' ? 'Node.js (CommonJS), main file index.js, with package.json listing dependencies. Use node-telegram-bot-api (polling).' : 'Python 3, main file main.py, with requirements.txt listing every third-party dependency. Use python-telegram-bot v21+ (async, Application.builder) unless the task needs otherwise.'}
- Read the bot token ONLY from the environment variable BOT_TOKEN. Never hardcode a token.
- Bot replies and button labels should be in the language of the user's request.
- No placeholders, no TODOs, no explanations. Code must run as-is.
- Output format (strictly): for every file, a header line "=== FILE: <relative path> ===" followed by the raw file content. No markdown fences, no text outside the files.`;

function parseFiles(text) {
  const files = {};
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^=== FILE:\s*(.+?)\s*===\s*$/);
    if (m) { cur = m[1].replace(/^\.?\//, ''); files[cur] = []; continue; }
    if (cur) files[cur].push(line);
  }
  const out = {};
  for (const [k, v] of Object.entries(files)) {
    let body = v.join('\n').replace(/^\s*\n/, '');
    body = body.replace(/^```[\w-]*\n/, '').replace(/\n```\s*$/, '').replace(/\s+$/, '') + '\n';
    if (k && !k.includes('..')) out[k] = body;
  }
  return out;
}

async function generate(description, lang) {
  const text = await chat(SYSTEM(lang), [{ role: 'user', content: `Build this Telegram bot:\n${description}` }]);
  const files = parseFiles(text);
  if (!Object.keys(files).length) throw new Error('النموذج لم يُرجع ملفات بالصيغة المطلوبة');
  return files;
}
async function fix(description, lang, files, error) {
  const dump = Object.entries(files).map(([k, v]) => `=== FILE: ${k} ===\n${v}`).join('\n');
  const text = await chat(SYSTEM(lang), [
    { role: 'user', content: `Task: ${description}\n\nCurrent files:\n${dump}\n\nRunning/checking them failed with this error:\n${error}\n\nFix the problem. Return ALL files again (complete, not diffs) in the same format.` },
  ]);
  const out = parseFiles(text);
  if (!Object.keys(out).length) throw new Error('النموذج لم يُرجع ملفات مصححة');
  return out;
}

module.exports = { configured, generate, fix, parseFiles, MAX_FIXES, MODEL, PROVIDER };
