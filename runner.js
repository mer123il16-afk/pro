'use strict';
/**
 * تشغيل البوتات: كل بوت = عملية منفصلة (أو حاوية Docker لو SANDBOX=docker)،
 * طابور لكل بوت يمنع التعارض، فحص syntax حقيقي، تثبيت مكتبات، لوجات حية، CPU/RAM.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DATA_DIR, botDir } = require('./db');

const SANDBOX = process.env.SANDBOX === 'docker' ? 'docker' : 'process';
const MAX_RAM_MB = Number(process.env.BOT_MAX_RAM_MB || 512);
const STARTUP_WAIT_MS = Number(process.env.STARTUP_WAIT_MS || 4000);
const PYTHON = process.env.PYTHON_BIN || 'python3';
const SKIP_DIRS = new Set(['.deps', 'node_modules', '.botforge', '__pycache__', '.git', '.cache', '.npm']);
const IS_PY = (f) => f.endsWith('.py');
const IS_JS = (f) => /\.(js|mjs|cjs)$/.test(f);

fs.mkdirSync(path.join(DATA_DIR, 'cache', 'pip'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'cache', 'npm'), { recursive: true });

// ---------------- القنوات واللوجات ----------------
const chans = new Map();
function chan(id) {
  let c = chans.get(id);
  if (!c) { c = { em: new EventEmitter(), buf: [], writes: 0 }; c.em.setMaxListeners(50); chans.set(id, c); }
  return c;
}
function logFile(id) { return path.join(botDir(id), '.botforge', 'log.txt'); }

/** stream: out | err | sys | step | ai */
function log(id, stream, text) {
  const c = chan(id);
  for (const line of String(text).split(/\r?\n/)) {
    if (line === '' ) continue;
    const e = { t: Date.now(), s: stream, m: line.slice(0, 4000) };
    c.buf.push(e);
    if (c.buf.length > 1500) c.buf.splice(0, c.buf.length - 1000);
    c.em.emit('log', e);
    try {
      fs.mkdirSync(path.dirname(logFile(id)), { recursive: true });
      if (++c.writes % 200 === 0 && fs.statSync(logFile(id)).size > 3e6) fs.renameSync(logFile(id), logFile(id) + '.old');
      fs.appendFileSync(logFile(id), `${new Date(e.t).toISOString()} [${stream}] ${e.m}\n`);
    } catch { /* ignore */ }
  }
}
function emitEvent(id, type, data) { chan(id).em.emit('event', { type, ...data }); }
function backlog(id, n = 300) {
  const c = chan(id);
  if (c.buf.length) return c.buf.slice(-n);
  try { // بعد إعادة تشغيل الخادم: اقرأ من الملف
    const lines = fs.readFileSync(logFile(id), 'utf8').split('\n').filter(Boolean).slice(-n);
    return lines.map((l) => {
      const m = l.match(/^(\S+) \[(\w+)\] (.*)$/);
      return m ? { t: Date.parse(m[1]), s: m[2], m: m[3] } : { t: Date.now(), s: 'sys', m: l };
    });
  } catch { return []; }
}
function subscribe(id, onLog, onEvent) {
  const c = chan(id);
  c.em.on('log', onLog); c.em.on('event', onEvent);
  return () => { c.em.off('log', onLog); c.em.off('event', onEvent); };
}

// ---------------- طابور لكل بوت + سيمافور للتثبيت ----------------
const queues = new Map();
function enqueue(id, fn) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(id, next);
  next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
  return next;
}
let installSlots = Number(process.env.MAX_PARALLEL_INSTALLS || 2);
const installWait = [];
async function withInstallSlot(fn) {
  if (installSlots <= 0) await new Promise((r) => installWait.push(r));
  else installSlots--;
  try { return await fn(); }
  finally { const n = installWait.shift(); if (n) n(); else installSlots++; }
}

// ---------------- تنفيذ أوامر مساعدة ----------------
function baseEnv(id, extra = {}) {
  const dir = botDir(id);
  return {
    PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8',
    PIP_CACHE_DIR: path.join(DATA_DIR, 'cache', 'pip'),
    npm_config_cache: path.join(DATA_DIR, 'cache', 'npm'),
    TMPDIR: path.join(dir, '.botforge', 'tmp'),
    ...extra,
  };
}
function exec(id, cmd, args, { timeout = 180000, stream = 'sys', echo = true, env = {} } = {}) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.join(botDir(id), '.botforge', 'tmp'), { recursive: true });
    let out = '';
    let c;
    try { c = spawn(cmd, args, { cwd: botDir(id), env: baseEnv(id, env), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: String(e.message) }); }
    const timer = setTimeout(() => { out += '\n[timeout]'; c.kill('SIGKILL'); }, timeout);
    const onData = (d) => { const s = d.toString(); out += s; if (echo) log(id, stream, s); };
    c.stdout.on('data', onData); c.stderr.on('data', onData);
    c.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: out + e.message }); });
    c.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function walk(dir, pred, base = dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), pred, base, acc); }
    else if (pred(e.name)) acc.push(path.relative(base, path.join(dir, e.name)));
  }
  return acc;
}

// ---------------- 1) فحص بنية الكود (مترجم اللغة الحقيقي) ----------------
const PY_SYNTAX = `
import os, json
skip = {'.deps','node_modules','.botforge','__pycache__','.git','.cache'}
errs = []
for r, d, f in os.walk('.'):
    d[:] = [x for x in d if x not in skip]
    for n in f:
        if n.endswith('.py'):
            p = os.path.join(r, n)
            try:
                compile(open(p, encoding='utf-8').read(), p, 'exec')
            except SyntaxError as e:
                errs.append({'file': os.path.relpath(p), 'line': e.lineno, 'col': e.offset, 'message': e.msg, 'text': (e.text or '').strip()})
            except Exception as e:
                errs.append({'file': os.path.relpath(p), 'line': 1, 'col': 1, 'message': str(e), 'text': ''})
print(json.dumps(errs))
`;
async function syntaxCheck(id, bot) {
  const dir = botDir(id);
  const errors = [];
  if (walk(dir, IS_PY).length) {
    const r = await exec(id, PYTHON, ['-I', '-c', PY_SYNTAX], { echo: false, timeout: 60000 });
    try { errors.push(...JSON.parse(r.out.trim().split('\n').pop() || '[]')); }
    catch { errors.push({ file: bot.main_file, line: 1, message: 'تعذر تشغيل مترجم بايثون: ' + r.out.slice(0, 300) }); }
  }
  for (const f of walk(dir, IS_JS)) {
    const r = await exec(id, 'node', ['--check', f], { echo: false, timeout: 60000 });
    if (r.code !== 0) {
      const lm = r.out.match(/:(\d+)\s*\n/);
      const mm = r.out.match(/(\w*Error: .*)/);
      const src = r.out.split('\n').find((l, i, a) => i > 0 && /^\s*\^/.test(a[i + 1] || '')) || '';
      errors.push({ file: f, line: lm ? Number(lm[1]) : 1, message: mm ? mm[1] : r.out.slice(0, 300), text: src.trim() });
    }
  }
  return errors;
}

// ---------------- 2) المكتبات ----------------
const PIP_MAP = {
  telegram: 'python-telegram-bot', telebot: 'pyTelegramBotAPI', yaml: 'PyYAML', PIL: 'Pillow', cv2: 'opencv-python-headless',
  bs4: 'beautifulsoup4', dotenv: 'python-dotenv', sklearn: 'scikit-learn', dateutil: 'python-dateutil', Crypto: 'pycryptodome',
  jwt: 'PyJWT', MySQLdb: 'mysqlclient', serial: 'pyserial', attr: 'attrs', OpenSSL: 'pyOpenSSL', magic: 'python-magic',
};
const PY_SCAN = `
import ast, os, sys, json, importlib.util
skip = {'.deps','node_modules','.botforge','__pycache__','.git','.cache'}
names = set()
for r, d, f in os.walk('.'):
    d[:] = [x for x in d if x not in skip]
    for n in f:
        if n.endswith('.py'):
            try: tree = ast.parse(open(os.path.join(r, n), encoding='utf-8').read())
            except Exception: continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for a in node.names: names.add(a.name.split('.')[0])
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    names.add(node.module.split('.')[0])
missing = []
for n in sorted(names):
    if n in sys.stdlib_module_names: continue
    try:
        if importlib.util.find_spec(n) is None: missing.append(n)
    except Exception: missing.append(n)
print(json.dumps(missing))
`;
async function pipInstall(id, pkgs) {
  return exec(id, PYTHON, ['-m', 'pip', 'install', '--target', '.deps', '--no-input', '--disable-pip-version-check', '--root-user-action=ignore', '--upgrade', ...pkgs], { timeout: 600000 });
}
async function pyMissing(id) {
  const r = await exec(id, PYTHON, ['-c', PY_SCAN], { echo: false, env: { PYTHONPATH: '.deps' }, timeout: 60000 });
  try { return JSON.parse(r.out.trim().split('\n').pop() || '[]'); } catch { return []; }
}
const NODE_BUILTINS = new Set(require('node:module').builtinModules);
function nodeImports(id) {
  const names = new Set();
  for (const f of walk(botDir(id), IS_JS)) {
    let src = ''; try { src = fs.readFileSync(path.join(botDir(id), f), 'utf8'); } catch { continue; }
    const re = /(?:require\(\s*|from\s+|import\s+)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      let n = m[1];
      if (n.startsWith('.') || n.startsWith('/') || n.startsWith('node:')) continue;
      n = n.startsWith('@') ? n.split('/').slice(0, 2).join('/') : n.split('/')[0];
      if (!NODE_BUILTINS.has(n)) names.add(n);
    }
  }
  return [...names];
}
async function installDeps(id, bot) {
  const dir = botDir(id);
  return withInstallSlot(async () => {
    if (bot.language === 'python') {
      if (fs.existsSync(path.join(dir, 'requirements.txt'))) {
        log(id, 'step', '📦 تثبيت المكتبات من requirements.txt ...');
        const r = await pipInstall(id, ['-r', 'requirements.txt']);
        if (r.code !== 0) return { ok: false, message: 'فشل pip install -r requirements.txt', detail: r.out.slice(-1500) };
      }
      const missing = await pyMissing(id);
      if (missing.length) {
        const pkgs = [...new Set(missing.map((n) => PIP_MAP[n] || n))];
        log(id, 'step', `📦 مكتبات ناقصة اكتُشفت من الكود: ${pkgs.join(', ')} — جاري التثبيت`);
        const r = await pipInstall(id, pkgs);
        const still = await pyMissing(id);
        if (r.code !== 0 || still.length) return { ok: false, message: `مكتبات غير متوفرة: ${(still.length ? still : missing).join(', ')}`, detail: r.out.slice(-1500) };
      }
      return { ok: true };
    }
    // node
    const pj = path.join(dir, 'package.json');
    if (!fs.existsSync(pj)) {
      const need = nodeImports(id);
      fs.writeFileSync(pj, JSON.stringify({ name: 'bot-' + id, version: '1.0.0', private: true, main: bot.main_file, dependencies: {} }, null, 2));
      if (need.length) {
        log(id, 'step', `📦 مكتبات مكتشفة من الكود: ${need.join(', ')}`);
        const r = await exec(id, 'npm', ['install', '--no-audit', '--no-fund', ...need], { timeout: 600000 });
        if (r.code !== 0) return { ok: false, message: 'فشل npm install', detail: r.out.slice(-1500) };
      }
      return { ok: true };
    }
    log(id, 'step', '📦 npm install ...');
    const r = await exec(id, 'npm', ['install', '--no-audit', '--no-fund'], { timeout: 600000 });
    if (r.code !== 0) return { ok: false, message: 'فشل npm install', detail: r.out.slice(-1500) };
    const miss = nodeImports(id).filter((n) => !fs.existsSync(path.join(dir, 'node_modules', n)));
    if (miss.length) {
      log(id, 'step', `📦 مكتبات ناقصة اكتُشفت من الكود: ${miss.join(', ')}`);
      const r2 = await exec(id, 'npm', ['install', '--no-audit', '--no-fund', ...miss], { timeout: 600000 });
      if (r2.code !== 0) return { ok: false, message: `مكتبات غير متوفرة: ${miss.join(', ')}`, detail: r2.out.slice(-1500) };
    }
    return { ok: true };
  });
}

// ---------------- 3) تشغيل العملية ----------------
const procs = new Map(); // id -> {child, pid, startedAt, stopping, prev, name}
let hooks = { onStatus() {} };
function setHooks(h) { hooks = { ...hooks, ...h }; }

function parseRuntimeError(text, bot) {
  const lines = String(text).split('\n');
  let file = bot.main_file, line = null, message = '';
  const py = [...text.matchAll(/File "([^"]+)", line (\d+)/g)];
  if (py.length) {
    const last = py[py.length - 1];
    file = last[1].replace(/^.*\/bots\/[^/]+\//, '').replace(/^\.\//, ''); line = Number(last[2]);
    message = lines.filter((l) => /^\w*(Error|Exception)\b|^\w+: /.test(l)).pop() || '';
  } else {
    const js = text.match(/([^\s(]+\.(?:js|mjs|cjs)):(\d+)(?::\d+)?/);
    if (js) { file = js[1].replace(/^.*\/bots\/[^/]+\//, ''); line = Number(js[2]); }
    message = lines.find((l) => /\w*Error\b/.test(l)) || '';
  }
  return { file, line, message: message.trim() || lines.filter(Boolean).slice(-1)[0] || 'خرج البوت بخطأ' };
}

function spawnBot(id, bot, token) {
  const dir = botDir(id);
  const env = { BOT_TOKEN: token, TELEGRAM_BOT_TOKEN: token, TOKEN: token, BOT_ID: id, PYTHONUNBUFFERED: '1', PYTHONPATH: '.deps', NODE_ENV: 'production' };
  if (process.env.TELEGRAM_API_BASE) env.TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE;
  const run = bot.language === 'python' ? [PYTHON, '-u', bot.main_file] : ['node', bot.main_file];
  let child;
  if (SANDBOX === 'docker') {
    const image = bot.language === 'python' ? (process.env.DOCKER_PY_IMAGE || 'python:3.12-slim') : (process.env.DOCKER_NODE_IMAGE || 'node:22-slim');
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const cmd = bot.language === 'python' ? ['python', '-u', bot.main_file] : ['node', bot.main_file];
    child = spawn('docker', ['run', '--rm', '--name', 'bf_' + id, '-m', `${MAX_RAM_MB}m`, '--cpus', '0.5', '--pids-limit', '128', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-v', `${dir}:/app`, '-w', '/app', ...envArgs, image, ...cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    child = spawn(run[0], run.slice(1), { cwd: dir, env: baseEnv(id, env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const p = { child, pid: child.pid, startedAt: Date.now(), stopping: false, prev: null, tail: '' };
  procs.set(id, p);
  const onData = (stream) => (d) => { const s = d.toString().split(token).join('***'); p.tail = (p.tail + s).slice(-6000); log(id, stream, s); };
  child.stdout.on('data', onData('out')); child.stderr.on('data', onData('err'));
  child.on('error', (e) => log(id, 'err', 'تعذر تشغيل العملية: ' + e.message));
  child.on('close', (code, sig) => {
    if (procs.get(id) === p) procs.delete(id);
    p.exited = { code, sig };
    const status = p.stopping ? 'stopped' : (code === 0 ? 'stopped' : 'error');
    log(id, 'sys', `⏹ انتهت العملية (code=${code ?? sig})`);
    if (!p.stopping && code !== 0) {
      const err = parseRuntimeError(p.tail, bot);
      emitEvent(id, 'crash', { error: err });
    }
    hooks.onStatus(id, status, null);
    emitEvent(id, 'status', { status });
  });
  return p;
}

function isRunning(id) { return procs.has(id); }

async function stop(id) {
  const p = procs.get(id);
  if (!p) return false;
  p.stopping = true;
  const done = new Promise((r) => p.child.once('close', r));
  try {
    if (SANDBOX === 'docker') spawn('docker', ['stop', '-t', '5', 'bf_' + id]);
    else process.kill(-p.pid, 'SIGTERM');
  } catch { /* already gone */ }
  const t = setTimeout(() => { try { if (SANDBOX === 'docker') spawn('docker', ['kill', 'bf_' + id]); else process.kill(-p.pid, 'SIGKILL'); } catch {} }, 5000);
  await done; clearTimeout(t);
  log(id, 'sys', '⏹ تم إيقاف البوت');
  return true;
}

/** بدء مباشر (بدون إعادة فحص) — يعيد {ok, error?} بعد فترة تأكد من الثبات */
async function start(id, bot, token) {
  if (procs.has(id)) await stop(id);
  log(id, 'sys', `▶ تشغيل ${bot.main_file} (${SANDBOX === 'docker' ? 'Docker' : 'process'})`);
  const p = spawnBot(id, bot, token);
  hooks.onStatus(id, 'running', null);
  emitEvent(id, 'status', { status: 'running' });
  const early = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), STARTUP_WAIT_MS);
    p.child.once('close', (code, sig) => { clearTimeout(t); resolve({ code, sig }); });
  });
  if (early && early.code !== 0) return { ok: false, error: parseRuntimeError(p.tail, bot), output: p.tail.slice(-2500) };
  if (early) return { ok: true, note: 'انتهى البوت بنجاح (exit 0) — لم يبقَ يعمل.' };
  return { ok: true, pid: p.pid };
}

/** زر «تشغيل وفحص» */
async function validateAndRun(id, bot, token, { checkToken }) {
  const step = (m) => { log(id, 'step', m); emitEvent(id, 'step', { text: m }); };
  const fail = (stage, error, extra = {}) => {
    const result = { ok: false, stage, error, ...extra, at: Date.now() };
    log(id, 'err', `❌ ${error.message}${error.line ? ` (${error.file}:${error.line})` : ''}`);
    hooks.onStatus(id, 'error', result); emitEvent(id, 'status', { status: 'error' }); emitEvent(id, 'result', { result });
    return result;
  };
  if (!bot.main_file || !fs.existsSync(path.join(botDir(id), bot.main_file))) return fail('files', { file: bot.main_file, message: 'لا يوجد ملف رئيسي للبوت. ارفع ملف البوت الرئيسي أولاً.' });
  if (procs.has(id)) { step('⏹ إيقاف النسخة الحالية ...'); await stop(id); }

  step('1/4 🔑 التحقق من التوكن (getMe) ...');
  if (!token) return fail('token', { message: 'لم يتم إدخال توكن البوت.' });
  const me = await checkToken(token);
  if (!me.ok) return fail('token', { message: 'التوكن غير صالح: ' + me.error });
  log(id, 'sys', `✅ التوكن صالح — @${me.username}`);

  step('2/4 🔍 فحص بنية الكود ...');
  const errs = await syntaxCheck(id, bot);
  if (errs.length) {
    const e = errs[0];
    return fail('syntax', { file: e.file, line: e.line, message: e.message, text: e.text }, { errors: errs });
  }
  log(id, 'sys', '✅ لا توجد أخطاء في بنية الكود');

  step('3/4 📦 فحص وتثبيت المكتبات ...');
  const dep = await installDeps(id, bot);
  if (!dep.ok) return fail('deps', { file: bot.language === 'python' ? 'requirements.txt' : 'package.json', message: dep.message, detail: dep.detail });
  log(id, 'sys', '✅ المكتبات جاهزة');

  step('4/4 🚀 تشغيل البوت ...');
  const s = await start(id, bot, token);
  if (!s.ok) return fail('runtime', s.error, { output: s.output });
  const result = { ok: true, stage: 'running', username: me.username, pid: s.pid, note: s.note, at: Date.now() };
  log(id, 'step', '✅ نجح التشغيل — البوت يعمل الآن');
  hooks.onStatus(id, s.pid ? 'running' : 'stopped', result);
  emitEvent(id, 'result', { result });
  return result;
}

// ---------------- الموارد ----------------
let CLK = 100;
function groupStat(pgid) {
  let ticks = 0, rss = 0;
  let dirs = [];
  try { dirs = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return null; }
  for (const d of dirs) {
    try {
      const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      if (Number(f[2]) !== pgid) continue;
      ticks += Number(f[11]) + Number(f[12]);
      rss += Number(fs.readFileSync(`/proc/${d}/statm`, 'utf8').split(' ')[1]) * 4096;
    } catch { /* process gone */ }
  }
  return { ticks, rss };
}
function dockerStats(id) {
  return new Promise((resolve) => {
    const c = spawn('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', 'bf_' + id]);
    let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => {
      const [cpu, mem] = o.trim().split('|'); const m = (mem || '').match(/([\d.]+)\s*(KiB|MiB|GiB)/);
      resolve({ cpu: parseFloat(cpu) || 0, ram_mb: m ? Number(m[1]) * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]]) : 0 });
    }); c.on('error', () => resolve(null));
  });
}
async function stats(id) {
  const p = procs.get(id);
  if (!p) return { running: false };
  if (SANDBOX === 'docker') { const d = await dockerStats(id); return { running: true, uptime: Date.now() - p.startedAt, ...(d || {}) }; }
  const g = groupStat(p.pid);
  if (!g) return { running: true, uptime: Date.now() - p.startedAt, cpu: 0, ram_mb: 0 };
  const now = Date.now();
  let cpu = 0;
  if (p.prev && now > p.prev.t) cpu = Math.max(0, ((g.ticks - p.prev.ticks) / CLK) / ((now - p.prev.t) / 1000) * 100);
  p.prev = { t: now, ticks: g.ticks };
  return { running: true, pid: p.pid, uptime: now - p.startedAt, cpu: Math.round(cpu * 10) / 10, ram_mb: Math.round(g.rss / 1048576 * 10) / 10 };
}
// حارس الذاكرة (وضع process)
setInterval(() => {
  if (SANDBOX !== 'process') return;
  for (const [id, p] of procs) {
    const g = groupStat(p.pid);
    if (g && g.rss / 1048576 > MAX_RAM_MB) { log(id, 'err', `⚠️ تجاوز حد الذاكرة (${MAX_RAM_MB}MB) — تم إيقاف البوت`); stop(id); }
  }
}, 3000).unref();

async function stopAll() { await Promise.all([...procs.keys()].map((id) => stop(id))); }

module.exports = { log, backlog, subscribe, emitEvent, enqueue, syntaxCheck, installDeps, start, stop, isRunning, stats, validateAndRun, setHooks, parseRuntimeError, stopAll, SANDBOX, walk, exec };
