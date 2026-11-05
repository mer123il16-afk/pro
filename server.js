/**
 * NEXORA Server — يشغّل البوتات 24/7 بدون ما يكون المتصفح مفتوح
 * النشر: Render.com (مجاني)
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { Worker }          = require('worker_threads');
const path                = require('path');

const PORT     = process.env.PORT     || 10000;
const SECRET   = process.env.SECRET   || '';   // اختياري: كلمة سر لحماية السيرفر

// ─── HTTP (Render يحتاج HTTP لفحص الصحة) ────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    status : 'ok',
    service: 'NEXORA Server 1.0',
    bots   : BOTS.size,
    uptime : Math.floor(process.uptime()) + 's',
    time   : new Date().toISOString()
  }));
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
const BOTS    = new Map();   // id → { worker, status, name }
const CLIENTS = new Set();

wss.on('connection', (ws, req) => {
  CLIENTS.add(ws);
  console.log(`[+] عميل متصل — المتصلون: ${CLIENTS.size}`);

  // إرسال حالة البوتات الحالية
  const statuses = [...BOTS.entries()].map(([id, b]) => ({ id, status: b.status, name: b.name }));
  safe(ws, { type: 'sync', statuses });

  ws.on('message', raw => {
    try { handle(ws, JSON.parse(raw.toString())); }
    catch (e) { console.error('رسالة سيئة:', e.message); }
  });

  ws.on('close', () => {
    CLIENTS.delete(ws);
    console.log(`[-] عميل غادر — المتصلون: ${CLIENTS.size}`);
  });

  ws.on('error', () => CLIENTS.delete(ws));
});

// ─── معالجة الأوامر ───────────────────────────────────────────────────────────
function handle(ws, msg) {
  // فحص كلمة السر إن وُجدت
  if (SECRET && msg.secret !== SECRET && msg.type !== 'ping') {
    return safe(ws, { type: 'error', m: '🔒 كلمة السر غلط' });
  }

  switch (msg.type) {
    case 'ping':
      return safe(ws, { type: 'pong' });

    case 'start':
      return startBot(ws, msg);

    case 'stop':
      return stopBot(msg.id);

    case 'restart':
      stopBot(msg.id);
      setTimeout(() => startBot(ws, msg), 1200);
      break;

    case 'list':
      const list = [...BOTS.entries()].map(([id, b]) => ({ id, status: b.status, name: b.name }));
      safe(ws, { type: 'list', bots: list });
      break;
  }
}

// ─── تشغيل البوت ──────────────────────────────────────────────────────────────
function startBot(ws, msg) {
  const { id, name, token, lang, main, files, env } = msg;

  if (BOTS.has(id)) {
    broadcast({ type: 'log', id, k: 'system', m: `"${name}" شغّال بالفعل على السيرفر ✅` });
    broadcast({ type: 'running', id });
    return;
  }

  broadcast({ type: 'log', id, k: 'system', m: `⏳ تشغيل "${name}" على السيرفر...` });

  const state = { worker: null, status: 'installing', name };
  BOTS.set(id, state);

  try {
    const worker = new Worker(path.join(__dirname, 'bot-worker.js'), {
      workerData: { id, name, token: token || '', lang: lang || 'py', main, files: files || {}, env: env || {} }
    });
    state.worker = worker;

    worker.on('message', m => {
      if (m.type === 'log')     broadcast({ type: 'log', id, k: m.k, m: m.m });
      else if (m.type === 'running') { state.status = 'running'; broadcast({ type: 'running', id }); }
      else if (m.type === 'exit')    { BOTS.delete(id); broadcast({ type: 'stopped', id }); }
    });

    worker.on('error', e => {
      broadcast({ type: 'log', id, k: 'error', m: '❌ ' + e.message });
      BOTS.delete(id);
      broadcast({ type: 'stopped', id });
    });

    worker.on('exit', () => {
      if (BOTS.has(id)) { BOTS.delete(id); broadcast({ type: 'stopped', id }); }
    });

  } catch (e) {
    broadcast({ type: 'log', id, k: 'error', m: '❌ فشل التشغيل: ' + e.message });
    BOTS.delete(id);
    broadcast({ type: 'stopped', id });
  }
}

// ─── إيقاف البوت ──────────────────────────────────────────────────────────────
function stopBot(id) {
  const bot = BOTS.get(id);
  if (bot?.worker) { try { bot.worker.terminate(); } catch(_) {} }
  BOTS.delete(id);
  broadcast({ type: 'log',     id, k: 'system', m: '⏹ أوقفه المالك' });
  broadcast({ type: 'stopped', id });
}

// ─── إرسال لكل العملاء ────────────────────────────────────────────────────────
function broadcast(data) {
  const json = JSON.stringify(data);
  for (const ws of CLIENTS) if (ws.readyState === 1) ws.send(json);
}
function safe(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

// ─── تشغيل السيرفر ────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => console.log(`🚀 NEXORA Server يشتغل على البورت ${PORT}`));
