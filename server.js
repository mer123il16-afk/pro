'use strict';
/**
 * BotForge — منصة استضافة بوتات تيليجرام. بدون أي dependency خارجية (Node 22+).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, botDir, encrypt, decrypt, DATA_DIR } = require('./lib/db');
const auth = require('./lib/auth');
const runner = require('./lib/runner');
const ai = require('./lib/ai');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const TG_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const MAX_BOTS = Number(process.env.MAX_BOTS_PER_USER || 10);
const ALLOW_REGISTER = process.env.ALLOW_REGISTER !== '0';
const MAX_BODY = 40 * 1024 * 1024;
const HIDDEN = new Set(['.deps', 'node_modules', '.botforge', '__pycache__', '.git', '.cache', '.npm']);

const now = () => Date.now();
const rid = () => crypto.randomBytes(5).toString('hex');
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// ---------------- Telegram ----------------
async function checkToken(token) {
  if (!/^\d{5,}:[\w-]{20,}$/.test(String(token || ''))) return { ok: false, error: 'صيغة التوكن غير صحيحة (مثال: 123456:ABC...)' };
  try {
    const r = await fetch(`${TG_BASE}/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (j.ok) return { ok: true, username: j.result.username, name: j.result.first_name, id: j.result.id };
    return { ok: false, error: j.description || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: 'تعذر الاتصال بتيليجرام: ' + e.message }; }
}

// ---------------- مساعدات البوت/الملفات ----------------
function langOf(file) { return /\.py$/.test(file) ? 'python' : /\.(js|mjs|cjs)$/.test(file) ? 'node' : null; }
function safeRel(p) {
  const rel = path.posix.normalize(String(p || '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!rel || rel === '.' || rel.startsWith('..') || rel.includes('\0')) throw new HttpError(400, 'مسار غير صالح');
  if (rel.split('/').some((s) => HIDDEN.has(s))) throw new HttpError(400, 'مسار محجوز');
  return rel;
}
function abs(id, rel) {
  const full = path.join(botDir(id), rel);
  if (!full.startsWith(botDir(id) + path.sep)) throw new HttpError(400, 'مسار غير صالح');
  return full;
}
function rowToBot(r) {
  return { id: r.id, name: r.name, language: r.language, main_file: r.main_file, has_token: Boolean(r.token_enc), token_username: r.token_username,
    status: runner.isRunning(r.id) ? 'running' : r.status === 'running' ? 'stopped' : r.status, last_result: r.last_result ? JSON.parse(r.last_result) : null, created_at: r.created_at, updated_at: r.updated_at };
}
function getBot(user, id) {
  const r = db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(id, user.id);
  if (!r) throw new HttpError(404, 'البوت غير موجود');
  return r;
}
const runCfg = (r) => ({ language: r.language, main_file: r.main_file });
function listFiles(id) {
  const base = botDir(id); const out = [];
  (function rec(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (HIDDEN.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else { const st = fs.statSync(p); out.push({ path: path.relative(base, p).split(path.sep).join('/'), size: st.size }); }
    }
  })(base);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
function touch(id) { db.prepare('UPDATE bots SET updated_at=? WHERE id=?').run(now(), id); }
function writeFile(id, rel, buf) {
  const full = abs(id, safeRel(rel));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
}

runner.setHooks({
  onStatus(id, status, result) {
    db.prepare('UPDATE bots SET status=?, updated_at=?' + (result ? ', last_result=?' : '') + ' WHERE id=?')
      .run(...[status, now(), ...(result ? [JSON.stringify(result)] : []), id]);
  },
});

// ---------------- الراوتر ----------------
const routes = [];
const route = (method, pattern, handler, { public: isPublic = false } = {}) => {
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, isPublic });
};

route('GET', '/api/health', () => ({ ok: true, sandbox: runner.SANDBOX, ai: ai.configured(), time: now() }), { public: true });

// ---- Auth ----
route('POST', '/api/auth/register', ({ body, ip }) => {
  if (!ALLOW_REGISTER) throw new HttpError(403, 'التسجيل مغلق');
  if (!auth.rateLimit('reg:' + ip, 10)) throw new HttpError(429, 'محاولات كثيرة، انتظر قليلاً');
  const email = String(body.email || '').trim().toLowerCase(), name = String(body.name || '').trim().slice(0, 60), pw = String(body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'البريد الإلكتروني غير صالح');
  if (pw.length < 8) throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 8 أحرف');
  if (!name) throw new HttpError(400, 'الاسم مطلوب');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'البريد مسجل مسبقاً');
  const r = db.prepare('INSERT INTO users(email,name,pass_hash,created_at) VALUES(?,?,?,?)').run(email, name, auth.hashPassword(pw), now());
  const id = Number(r.lastInsertRowid);
  return { token: auth.signJwt({ uid: id }), user: { id, email, name } };
}, { public: true });
route('POST', '/api/auth/login', ({ body, ip }) => {
  if (!auth.rateLimit('login:' + ip, 20)) throw new HttpError(429, 'محاولات كثيرة، انتظر قليلاً');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(body.email || '').trim().toLowerCase());
  if (!u || !auth.verifyPassword(String(body.password || ''), u.pass_hash)) throw new HttpError(401, 'بيانات الدخول غير صحيحة');
  return { token: auth.signJwt({ uid: u.id }), user: { id: u.id, email: u.email, name: u.name } };
}, { public: true });
route('GET', '/api/me', ({ user }) => ({ user: { id: user.id, email: user.email, name: user.name }, ai: ai.configured(), sandbox: runner.SANDBOX }));

// ---- Bots ----
route('GET', '/api/bots', async ({ user }) => {
  const rows = db.prepare('SELECT * FROM bots WHERE user_id=? ORDER BY created_at DESC').all(user.id);
  return Promise.all(rows.map(async (r) => ({ ...rowToBot(r), stats: runner.isRunning(r.id) ? await runner.stats(r.id) : null })));
});
route('POST', '/api/bots', ({ user, body }) => {
  if (db.prepare('SELECT COUNT(*) c FROM bots WHERE user_id=?').get(user.id).c >= MAX_BOTS) throw new HttpError(403, `الحد الأقصى ${MAX_BOTS} بوتات`);
  const name = String(body.name || '').trim().slice(0, 60) || 'بوت جديد';
  const language = body.language === 'node' ? 'node' : 'python';
  const id = rid();
  fs.mkdirSync(path.join(botDir(id), '.botforge'), { recursive: true });
  db.prepare('INSERT INTO bots(id,user_id,name,language,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, user.id, name, language, now(), now());
  return rowToBot(getBot(user, id));
});
route('GET', '/api/bots/:id', ({ user, params }) => rowToBot(getBot(user, params.id)));
route('PUT', '/api/bots/:id', ({ user, params, body }) => {
  getBot(user, params.id);
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'الاسم مطلوب');
  db.prepare('UPDATE bots SET name=?, updated_at=? WHERE id=?').run(name, now(), params.id);
  return rowToBot(getBot(user, params.id));
});
route('DELETE', '/api/bots/:id', ({ user, params }) => runner.enqueue(params.id, async () => {
  getBot(user, params.id);
  await runner.stop(params.id);
  db.prepare('DELETE FROM bots WHERE id=?').run(params.id);
  fs.rmSync(botDir(params.id), { recursive: true, force: true });
  return { ok: true };
}));

// ---- التوكن ----
route('PUT', '/api/bots/:id/token', async ({ user, params, body }) => {
  getBot(user, params.id);
  const token = String(body.token || '').trim();
  const me = await checkToken(token);
  if (!me.ok) throw new HttpError(400, 'التوكن غير صالح: ' + me.error);
  db.prepare('UPDATE bots SET token_enc=?, token_username=?, updated_at=? WHERE id=?').run(encrypt(token), me.username, now(), params.id);
  return { ok: true, username: me.username, name: me.name };
});
route('POST', '/api/bots/:id/token/check', async ({ user, params }) => {
  const r = getBot(user, params.id);
  return checkToken(decrypt(r.token_enc));
});

// ---- الملفات: ملف رئيسي منفصل + ملفات إضافية. الربط عبر معرّف المشروع الداخلي (bot id) ----
route('POST', '/api/bots/:id/main', ({ user, params, body }) => {
  const r = getBot(user, params.id);
  const name = path.posix.basename(String(body.name || '').replace(/\\/g, '/'));
  const lang = langOf(name);
  if (!lang) throw new HttpError(400, 'الملف الرئيسي يجب أن يكون .py أو .js');
  writeFile(params.id, name, Buffer.from(String(body.content_b64 || ''), 'base64'));
  db.prepare('UPDATE bots SET main_file=?, language=?, updated_at=? WHERE id=?').run(name, lang, now(), params.id);
  return rowToBot(getBot(user, params.id));
});
route('PUT', '/api/bots/:id/main', ({ user, params, body }) => {
  getBot(user, params.id);
  const rel = safeRel(body.path); const lang = langOf(rel);
  if (!lang) throw new HttpError(400, 'الملف الرئيسي يجب أن يكون .py أو .js');
  if (!fs.existsSync(abs(params.id, rel))) throw new HttpError(404, 'الملف غير موجود');
  db.prepare('UPDATE bots SET main_file=?, language=?, updated_at=? WHERE id=?').run(rel, lang, now(), params.id);
  return rowToBot(getBot(user, params.id));
});
route('POST', '/api/bots/:id/files', ({ user, params, body }) => {
  getBot(user, params.id);
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > 3000) throw new HttpError(400, 'عدد الملفات كبير جداً');
  let n = 0;
  for (const f of files) { writeFile(params.id, f.path, Buffer.from(String(f.content_b64 || ''), 'base64')); n++; }
  touch(params.id);
  return { ok: true, count: n, files: listFiles(params.id) };
});
route('GET', '/api/bots/:id/files', ({ user, params }) => { getBot(user, params.id); return { files: listFiles(params.id) }; });
route('GET', '/api/bots/:id/file', ({ user, params, query }) => {
  getBot(user, params.id);
  const full = abs(params.id, safeRel(query.path));
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(404, 'الملف غير موجود');
  if (fs.statSync(full).size > 2 * 1024 * 1024) throw new HttpError(413, 'الملف كبير جداً للتحرير');
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) throw new HttpError(415, 'ملف ثنائي — لا يمكن عرضه في المحرر');
  return { path: query.path, content: buf.toString('utf8') };
});
route('PUT', '/api/bots/:id/file', ({ user, params, body }) => {
  getBot(user, params.id);
  writeFile(params.id, body.path, Buffer.from(String(body.content ?? ''), 'utf8'));
  touch(params.id);
  return { ok: true };
});
route('DELETE', '/api/bots/:id/file', ({ user, params, query }) => {
  const r = getBot(user, params.id);
  const rel = safeRel(query.path);
  if (rel === r.main_file) throw new HttpError(400, 'لا يمكن حذف الملف الرئيسي — غيّره أولاً');
  fs.rmSync(abs(params.id, rel), { recursive: true, force: true });
  touch(params.id);
  return { ok: true };
});
route('POST', '/api/bots/:id/move', ({ user, params, body }) => {
  const r = getBot(user, params.id);
  const from = safeRel(body.from), to = safeRel(body.to);
  if (!fs.existsSync(abs(params.id, from))) throw new HttpError(404, 'المصدر غير موجود');
  if (fs.existsSync(abs(params.id, to))) throw new HttpError(409, 'الوجهة موجودة مسبقاً');
  fs.mkdirSync(path.dirname(abs(params.id, to)), { recursive: true });
  fs.renameSync(abs(params.id, from), abs(params.id, to));
  // الربط لا ينكسر: لو نُقل الملف الرئيسي (أو مجلده) نحدّث مساره داخل قاعدة البيانات
  let main = r.main_file;
  if (main === from) main = to; else if (main && main.startsWith(from + '/')) main = to + main.slice(from.length);
  if (main !== r.main_file) db.prepare('UPDATE bots SET main_file=?, language=? WHERE id=?').run(main, langOf(main) || r.language, params.id);
  touch(params.id);
  return { ok: true, main_file: main, files: listFiles(params.id) };
});

// ---- التشغيل والتحكم (كلها عبر طابور البوت) ----
route('POST', '/api/bots/:id/check', ({ user, params }) => {
  const r = getBot(user, params.id);
  return runner.enqueue(params.id, async () => {
    const errors = await runner.syntaxCheck(params.id, runCfg(r));
    return { ok: errors.length === 0, errors };
  });
});
route('POST', '/api/bots/:id/run', ({ user, params }) => {
  const r = getBot(user, params.id);
  return runner.enqueue(params.id, () => runner.validateAndRun(params.id, runCfg(r), decrypt(r.token_enc), { checkToken }).then((res) => {
    db.prepare('UPDATE bots SET desired=? WHERE id=?').run(res.ok ? 'running' : 'stopped', params.id); return res;
  }));
});
route('POST', '/api/bots/:id/start', ({ user, params }) => {
  const r = getBot(user, params.id);
  return runner.enqueue(params.id, async () => {
    if (runner.isRunning(params.id)) return { ok: true, note: 'يعمل بالفعل' };
    const token = decrypt(r.token_enc);
    if (!token) throw new HttpError(400, 'أضف توكن البوت أولاً');
    if (!r.main_file) throw new HttpError(400, 'ارفع الملف الرئيسي أولاً');
    const res = await runner.start(params.id, runCfg(r), token);
    db.prepare('UPDATE bots SET desired=? WHERE id=?').run(res.ok ? 'running' : 'stopped', params.id);
    if (!res.ok) { runner.log(params.id, 'err', '❌ ' + res.error.message); db.prepare('UPDATE bots SET status=? WHERE id=?').run('error', params.id); }
    return res;
  });
});
route('POST', '/api/bots/:id/stop', ({ user, params }) => {
  getBot(user, params.id);
  return runner.enqueue(params.id, async () => {
    db.prepare('UPDATE bots SET desired=? WHERE id=?').run('stopped', params.id);
    await runner.stop(params.id);
    db.prepare('UPDATE bots SET status=? WHERE id=?').run('stopped', params.id);
    runner.emitEvent(params.id, 'status', { status: 'stopped' });
    return { ok: true };
  });
});
route('POST', '/api/bots/:id/restart', ({ user, params }) => {
  const r = getBot(user, params.id);
  return runner.enqueue(params.id, async () => {
    await runner.stop(params.id);
    const token = decrypt(r.token_enc);
    if (!token || !r.main_file) throw new HttpError(400, 'التوكن أو الملف الرئيسي غير مكتمل');
    const res = await runner.start(params.id, runCfg(r), token);
    db.prepare('UPDATE bots SET desired=? WHERE id=?').run(res.ok ? 'running' : 'stopped', params.id);
    return res;
  });
});
route('GET', '/api/bots/:id/stats', async ({ user, params }) => { getBot(user, params.id); return runner.stats(params.id); });
route('GET', '/api/bots/:id/logs', ({ user, params, query }) => { getBot(user, params.id); return { logs: runner.backlog(params.id, Number(query.n) || 300) }; });

// ---- AI ----
route('GET', '/api/ai/status', () => ({ configured: ai.configured(), model: ai.MODEL, provider: ai.PROVIDER, max_fixes: ai.MAX_FIXES }));
route('POST', '/api/ai/generate', async ({ user, body }) => {
  if (!ai.configured()) throw new HttpError(503, 'الذكاء الاصطناعي غير مفعّل على الخادم. اضبط AI_API_KEY (انظر README).');
  const description = String(body.description || '').trim();
  if (description.length < 5) throw new HttpError(400, 'اكتب وصفاً للبوت');
  if (db.prepare('SELECT COUNT(*) c FROM bots WHERE user_id=?').get(user.id).c >= MAX_BOTS) throw new HttpError(403, `الحد الأقصى ${MAX_BOTS} بوتات`);
  const language = body.language === 'node' ? 'node' : 'python';
  const id = rid();
  fs.mkdirSync(path.join(botDir(id), '.botforge'), { recursive: true });
  const name = description.slice(0, 40);
  let token = '', username = null;
  if (body.token) { const me = await checkToken(String(body.token).trim()); if (me.ok) { token = String(body.token).trim(); username = me.username; } }
  db.prepare('INSERT INTO bots(id,user_id,name,language,token_enc,token_username,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, user.id, name, language, token ? encrypt(token) : null, username, now(), now());
  if (body.token && !token) runner.log(id, 'step', '⚠️ التوكن المُدخل غير صالح — سيتم الفحص بدون تشغيل حقيقي');
  runAiJob(id, description, language, token).catch((e) => runner.log(id, 'err', '❌ فشلت المهمة: ' + e.message));
  return { bot_id: id };
});

function saveFiles(id, files, language) {
  for (const [p, c] of Object.entries(files)) writeFile(id, p, Buffer.from(c, 'utf8'));
  const prefer = language === 'node' ? ['index.js', 'main.js', 'bot.js'] : ['main.py', 'bot.py', 'app.py'];
  const main = prefer.find((f) => files[f]) || Object.keys(files).find((f) => langOf(f) === language) || Object.keys(files).find((f) => langOf(f));
  if (main) db.prepare('UPDATE bots SET main_file=?, language=?, updated_at=? WHERE id=?').run(main, langOf(main), now(), id);
  return main;
}
const isAuthErr = (t) => /unauthorized|invalid ?token|not found.*bot|401/i.test(t || '');

async function runAiJob(id, description, language, token) {
  const step = (m) => { runner.log(id, 'step', m); runner.emitEvent(id, 'step', { text: m }); };
  const finish = (ok, msg) => { runner.emitEvent(id, 'ai_done', { ok, message: msg }); };
  step('🤖 جاري توليد الكود بالذكاء الاصطناعي ...');
  let files = await ai.generate(description, language);
  let main = saveFiles(id, files, language);
  step(`💾 تم الحفظ في المشروع: ${Object.keys(files).join(', ')}`);
  for (let attempt = 0; attempt <= ai.MAX_FIXES; attempt++) {
    const bot = () => { const r = db.prepare('SELECT * FROM bots WHERE id=?').get(id); return runCfg(r); };
    let err = null;
    step(attempt ? `🔍 فحص النسخة المصححة (محاولة ${attempt}/${ai.MAX_FIXES}) ...` : '🔍 جاري فحص بنية الكود ...');
    const errs = await runner.syntaxCheck(id, bot());
    if (errs.length) err = `Syntax error in ${errs[0].file}:${errs[0].line}: ${errs[0].message}\n${errs[0].text || ''}`;
    if (!err) {
      step('📦 جاري فحص وتثبيت المكتبات ...');
      const dep = await runner.installDeps(id, bot());
      if (!dep.ok) err = `Dependency error: ${dep.message}\n${dep.detail || ''}`;
    }
    if (!err && token) {
      step('🚀 تشغيل تجريبي في Sandbox ...');
      const res = await runner.enqueue(id, () => runner.start(id, bot(), token));
      if (!res.ok) {
        const out = res.output || res.error.message;
        if (isAuthErr(out)) { step('⚠️ رفض تيليجرام التوكن أثناء التشغيل — الكود سليم، تحقق من التوكن'); finish(true, 'الكود جاهز لكن التوكن مرفوض'); return; }
        err = `Runtime error:\n${out}`;
      } else step('✅ البوت يعمل في الـ Sandbox');
    }
    if (!err) {
      if (token && runner.isRunning(id)) db.prepare('UPDATE bots SET desired=? WHERE id=?').run('running', id);
      db.prepare('UPDATE bots SET last_result=? WHERE id=?').run(JSON.stringify({ ok: true, stage: token ? 'running' : 'checked', at: now() }), id);
      step(token ? '🎉 اكتمل: البوت جاهز ويعمل' : '🎉 اكتمل: الكود سليم والمكتبات مثبتة — أضف التوكن واضغط «تشغيل وفحص»');
      finish(true, 'تم'); return;
    }
    step(`❌ خطأ: ${err.split('\n')[0].slice(0, 200)}`);
    if (attempt === ai.MAX_FIXES) { step(`⛔ توقفت بعد ${ai.MAX_FIXES} محاولات تصحيح — يمكنك التعديل يدوياً من المحرر`); finish(false, err.slice(0, 300)); return; }
    step(`🛠 إرسال الخطأ للذكاء الاصطناعي لإصلاحه (محاولة ${attempt + 1}/${ai.MAX_FIXES}) ...`);
    await runner.enqueue(id, () => runner.stop(id));
    files = await ai.fix(description, language, files, err);
    main = saveFiles(id, files, language);
    step('✏️ تم تطبيق الإصلاح');
  }
}

// ---------------- SSE ----------------
function sse(req, res, user, params) {
  getBot(user, params.id);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  send('backlog', { logs: runner.backlog(params.id, 300), status: runner.isRunning(params.id) ? 'running' : undefined });
  const off = runner.subscribe(params.id, (e) => send('log', e), (e) => send('event', e));
  const hb = setInterval(() => res.write(': hb\n\n'), 20000);
  req.on('close', () => { clearInterval(hb); off(); });
}

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC, path.normalize(p));
  if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { p = '/index.html'; }
  const f = path.join(PUBLIC, path.normalize(p));
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(f).pipe(res);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new HttpError(413, 'الحجم كبير جداً')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'JSON غير صالح')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    // SSE
    const sm = url.pathname.match(/^\/api\/bots\/([^/]+)\/stream$/);
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token') || '';
    const getUser = () => {
      const p = auth.verifyJwt(bearer);
      const u = p && db.prepare('SELECT id,email,name FROM users WHERE id=?').get(p.uid);
      if (!u) throw new HttpError(401, 'غير مصرح — سجّل الدخول');
      return u;
    };
    if (sm && req.method === 'GET') return sse(req, res, getUser(), { id: sm[1] });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const user = r.isPublic ? null : getUser();
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler({ req, user, params: m.groups || {}, query: Object.fromEntries(url.searchParams), body, ip });
      return json(200, out);
    }
    throw new HttpError(404, 'غير موجود');
  } catch (e) {
    if (e instanceof HttpError) return json(e.code, { error: e.message });
    console.error(e);
    return json(500, { error: 'خطأ داخلي في الخادم' });
  }
});

// استعادة البوتات التي كانت تعمل قبل إعادة تشغيل الخادم
async function restoreRunning() {
  const rows = db.prepare("SELECT * FROM bots WHERE desired='running' AND token_enc IS NOT NULL AND main_file IS NOT NULL").all();
  for (const r of rows) {
    runner.enqueue(r.id, async () => {
      runner.log(r.id, 'sys', '🔄 استعادة تلقائية بعد إعادة تشغيل الخادم');
      const res = await runner.start(r.id, runCfg(r), decrypt(r.token_enc));
      if (!res.ok) { db.prepare("UPDATE bots SET status='error' WHERE id=?").run(r.id); }
    });
  }
}

if (require.main === module) {
  server.listen(PORT, HOST, () => { console.log(`BotForge listening on http://${HOST}:${PORT}  (sandbox=${runner.SANDBOX}, ai=${ai.configured()})`); restoreRunning(); });
  const shutdown = async () => { console.log('shutting down...'); server.close(); await runner.stopAll(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
module.exports = { server };
