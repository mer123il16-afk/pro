/**
 * bot-worker.js — يشتغل داخل Worker Thread مستقل لكل بوت
 * يدعم بايثون (python3) وجافاسكربت (Node.js)
 */

const { workerData, parentPort } = require('worker_threads');
const { id, name, token, lang, main, files, env } = workerData;

const post = (type, extra = {}) => parentPort.postMessage({ type, ...extra });

process.on('uncaughtException', e => { post('log', { k: 'error', m: '❌ ' + e.message }); post('exit', { code: 1 }); });

(async () => {
  try {
    if      (lang === 'js') await runJs();
    else if (lang === 'py') await runPy();
    else { post('log', { k: 'error', m: '❌ لغة غير مدعومة: ' + lang }); post('exit', { code: 1 }); }
  } catch (e) {
    post('log', { k: 'error', m: '❌ ' + (e.message || e) });
    post('exit', { code: 1 });
  }
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  تشغيل بوت جافاسكربت
// ═══════════════════════════════════════════════════════════════════════════════
async function runJs() {
  const botEnv = { BOT_TOKEN: token, TELEGRAM_TOKEN: token, TOKEN: token, ...env };
  const sleep  = ms => new Promise(r => setTimeout(r, ms));

  const con = {
    log  : (...a) => post('log', { k: 'info',   m: a.map(String).join(' ') }),
    error: (...a) => post('log', { k: 'error',  m: a.map(String).join(' ') }),
    warn : (...a) => post('log', { k: 'system', m: a.map(String).join(' ') }),
    info : (...a) => post('log', { k: 'info',   m: a.map(String).join(' ') }),
  };

  function createBot(tkn) {
    const base = `https://api.telegram.org/bot${tkn}/`;
    const cmds = {}, msgs = [], cbs = [];
    let offset = 0;

    const tg = async (method, params) => {
      const r = await fetch(`${base}${method}`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify(params || {})
      });
      return r.json();
    };

    const mk = upd => {
      const cb = upd.callback_query;
      const m  = upd.message || (cb && cb.message) || {};
      const tx = (upd.message && upd.message.text) || '';
      const ctx = {
        update: upd, message: m, callback: cb, text: tx,
        data  : cb && cb.data,
        user  : (upd.message || cb || {}).from || {},
        chatId: (m.chat || {}).id,
        args  : tx.startsWith('/') ? tx.split(/\s+/).slice(1) : [],
      };
      ctx.reply  = (t, x) => tg('sendMessage',           { chat_id: ctx.chatId, text: t, ...(x||{}) });
      ctx.answer = (t, x) => cb ? tg('answerCallbackQuery', { callback_query_id: cb.id, text: t||'', ...(x||{}) }) : null;
      return ctx;
    };

    const call = async (fn, ctx) => { try { await fn(ctx); } catch (e) { post('log', { k: 'error', m: '❌ ' + e.message }); } };

    const handle = async upd => {
      const ctx = mk(upd);
      if (ctx.callback) { for (const f of cbs) await call(f, ctx); }
      else if (ctx.text && ctx.text.startsWith('/')) {
        const c = ctx.text.split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();
        if (cmds[c]) await call(cmds[c], ctx);
      } else if (upd.message) { for (const f of msgs) await call(f, ctx); }
    };

    return {
      api: tg,
      command(n, fn) { cmds[n.replace(/^\//, '').toLowerCase()] = fn; },
      on(type, fn)   { (type === 'callback_query' ? cbs : msgs).push(fn); },
      sendMessage(chatId, text, x) { return tg('sendMessage', { chat_id: chatId, text, ...(x||{}) }); },
      async launch() {
        try {
          const me = await tg('getMe');
          if (!me.ok) { post('log', { k: 'error', m: '❌ التوكن غلط: ' + me.description }); post('exit', { code: 1 }); return; }
          post('log', { k: 'info', m: '🤖 يشتغل على السيرفر: @' + me.result.username });
          post('running');
          await tg('deleteWebhook');
          for (;;) {
            try {
              const r = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
              if (!r.ok) { post('log', { k: 'error', m: '⚠️ تيليجرام: ' + r.description }); await sleep(5000); continue; }
              for (const u of r.result) { offset = u.update_id + 1; handle(u); }
            } catch (e) { post('log', { k: 'error', m: '⚠️ شبكة: ' + e.message }); await sleep(3000); }
          }
        } catch (e) { post('log', { k: 'error', m: '❌ ' + e.message }); post('exit', { code: 1 }); }
      }
    };
  }

  const code = files[main];
  if (!code) { post('log', { k: 'error', m: '❌ ما وجدت الملف: ' + main }); post('exit', { code: 1 }); return; }

  const Fn = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new Fn('process', 'createBot', 'console', 'fetch', code);
  await fn({ env: botEnv }, createBot, con, fetch);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  تشغيل بوت بايثون
// ═══════════════════════════════════════════════════════════════════════════════
async function runPy() {
  const { spawn, execFileSync } = require('child_process');
  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-'));

  try {
    // كتابة ملفات البوت
    for (const [fp, content] of Object.entries(files)) {
      const full = path.join(tmpDir, fp);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }

    // كتابة مكتبة nexora_tg للسيرفر
    fs.writeFileSync(path.join(tmpDir, 'nexora_tg.py'), NEXORA_TG_PY, 'utf8');

    // متغيرات البيئة
    const envVars = {
      ...process.env,
      BOT_TOKEN       : token,
      TELEGRAM_TOKEN  : token,
      TOKEN           : token,
      PYTHONPATH      : tmpDir,
      PYTHONUNBUFFERED: '1',
      ...env
    };

    // تثبيت المكتبات
    const req = files['requirements.txt'];
    if (req) {
      const specs = req.split('\n').map(l => l.split('#')[0].trim()).filter(l => l && !l.startsWith('-'));
      for (const spec of specs) {
        post('log', { k: 'install', m: `📦 تثبيت ${spec}...` });
        try {
          execFileSync('pip3', ['install', spec, '-q', '--break-system-packages'], { env: envVars, timeout: 120000, stdio: 'pipe' });
          post('log', { k: 'success', m: `✅ ${spec}` });
        } catch (_) {
          try {
            execFileSync('pip3', ['install', spec, '-q'], { env: envVars, timeout: 120000, stdio: 'pipe' });
            post('log', { k: 'success', m: `✅ ${spec}` });
          } catch (e2) {
            post('log', { k: 'error', m: `⚠️ ما أمكن تثبيت ${spec}` });
          }
        }
      }
    }

    post('log', { k: 'system', m: `▶ تشغيل ${main} على السيرفر...` });

    const py = spawn('python3', ['-u', path.join(tmpDir, main)], {
      cwd : tmpDir,
      env : envVars,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let started = false;
    const markStarted = () => { if (!started) { started = true; setTimeout(() => post('running'), 200); } };

    py.stdout.on('data', data => {
      data.toString().split('\n').filter(l => l.trim()).forEach(line => {
        post('log', { k: 'info', m: line });
        if (line.includes('شغّال') || line.includes('@') || line.includes('running') || line.includes('Polling'))
          markStarted();
      });
    });

    py.stderr.on('data', data => {
      data.toString().split('\n').filter(l => l.trim()).forEach(line => post('log', { k: 'error', m: line }));
    });

    // إذا ما انطلق خلال 6 ثوان، افترض أنه شغّال
    setTimeout(markStarted, 6000);

    await new Promise(resolve => py.on('close', resolve));

  } finally {
    try { require('fs').rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
    post('exit', { code: 0 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  مكتبة nexora_tg للسيرفر (بدون Pyodide)
// ═══════════════════════════════════════════════════════════════════════════════
const NEXORA_TG_PY = `
import os, json, asyncio, urllib.request

class Ctx:
    def __init__(self, bot, upd):
        self.bot      = bot
        self.update   = upd
        self.callback = upd.get("callback_query")
        self.message  = upd.get("message") or (self.callback or {}).get("message") or {}
        self.user     = (upd.get("message") or self.callback or {}).get("from", {})
        self.chat_id  = (self.message.get("chat") or {}).get("id")
        self.text     = (upd.get("message") or {}).get("text", "") or ""
        self.data     = (self.callback or {}).get("data")
        self.args     = self.text.split()[1:] if self.text.startswith("/") else []

    async def reply(self, text, **kw):
        return await self.bot.send_message(self.chat_id, text, **kw)

    async def answer(self, text="", **kw):
        if self.callback:
            return await self.bot.api("answerCallbackQuery",
                callback_query_id=self.callback["id"], text=text, **kw)


class Bot:
    def __init__(self, token=None):
        self.token  = token or os.environ.get("BOT_TOKEN") or os.environ.get("TELEGRAM_TOKEN") or os.environ.get("TOKEN", "")
        self._cmds  = {}
        self._msg   = []
        self._cb    = []
        self.offset = 0

    def _raw(self, method, **params):
        url  = f"https://api.telegram.org/bot{self.token}/{method}"
        data = json.dumps(params).encode()
        req  = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=35) as r:
            return json.loads(r.read())

    async def api(self, method, **params):
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, lambda: self._raw(method, **params))

    async def send_message(self, chat_id, text, **kw):
        return await self.api("sendMessage", chat_id=chat_id, text=text, **kw)

    def command(self, cmd):
        def dec(fn):
            self._cmds[cmd.lower().lstrip("/")] = fn
            return fn
        return dec

    def message(self, fn):
        self._msg.append(fn); return fn

    def callback(self, fn):
        self._cb.append(fn); return fn

    async def _dispatch(self, fn, ctx):
        try:
            r = fn(ctx)
            if asyncio.iscoroutine(r): await r
        except Exception as e:
            print(f"\\u274c \\u062e\\u0637\\u0623 \\u062f\\u0627\\u062e\\u0644 \\u0627\\u0644\\u0645\\u0639\\u0627\\u0644\\u062c: {e!r}")

    async def _handle(self, upd):
        ctx = Ctx(self, upd)
        if ctx.callback:
            for fn in self._cb: await self._dispatch(fn, ctx)
        elif ctx.text.startswith("/"):
            cmd = ctx.text.split()[0][1:].split("@")[0].lower()
            if cmd in self._cmds: await self._dispatch(self._cmds[cmd], ctx)
        elif upd.get("message"):
            for fn in self._msg: await self._dispatch(fn, ctx)

    async def _polling(self):
        me = await self.api("getMe")
        if not me.get("ok"):
            print("\\u274c \\u0627\\u0644\\u062a\\u0648\\u0643\\u0646 \\u063a\\u0644\\u0637:", me.get("description")); return
        print(f"\\U0001f916 \\u064a\\u0634\\u062a\\u063a\\u0651\\u0627\\u0644 \\u0639\\u0644\\u0649 \\u0627\\u0644\\u0633\\u064a\\u0631\\u0641\\u0631: @{me['result'].get('username','')}")
        await self.api("deleteWebhook")
        while True:
            try:
                res = await self.api("getUpdates", offset=self.offset, timeout=25,
                                     allowed_updates=["message", "callback_query"])
                if not res.get("ok"):
                    await asyncio.sleep(5); continue
                for u in res["result"]:
                    self.offset = u["update_id"] + 1
                    asyncio.ensure_future(self._handle(u))
            except asyncio.CancelledError: raise
            except Exception as e:
                print(f"\\u26a0\\ufe0f \\u0634\\u0628\\u0643\\u0629: {e!r}"); await asyncio.sleep(3)

    def run(self):
        asyncio.run(self._polling())

NexoraBot = Bot
`;
