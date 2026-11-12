'use strict';
/* BotForge SPA — بدون مكتبات. كل النصوص تُدرج عبر textContent (آمن من XSS). */

// ---------- أدوات ----------
const $app = document.getElementById('app');
function fatal(msg) { document.getElementById('boot')?.remove(); $app.replaceChildren(Object.assign(document.createElement('div'), { style: 'max-width:560px;margin:12vh auto;padding:24px;line-height:1.9', innerHTML: '<h2 style="color:#ff5d6c">تعذر تشغيل الواجهة</h2><p></p>' })); $app.querySelector('p').textContent = msg; }
if (location.protocol === 'file:') { fatal('فتحت الملف مباشرة. هذه المنصة تحتاج الخادم: استخرج الـ Zip، شغّل node --no-warnings server.js ثم افتح http://localhost:3000'); throw new Error('opened via file://'); }
window.addEventListener('error', (e) => { if (!document.querySelector('.hero,.authwrap,.shell')) fatal('خطأ في الواجهة: ' + e.message); });
const MONACO_VER = '0.52.0';
const store = {
  get token() { try { return localStorage.getItem('bf_token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('bf_token', v) : localStorage.removeItem('bf_token'); } catch {} },
};
let ME = null;
let cleanup = [];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // فقط لمحتوى ثابت من الكود
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
const svgLogo = '<svg viewBox="0 0 32 32"><path d="M9 22V10h7a3.5 3.5 0 0 1 0 7H9m7 0a3.5 3.5 0 0 1 0 5H9" fill="none" stroke="#04130f" stroke-width="2.6" stroke-linecap="round"/></svg>';
const logo = () => h('a', { class: 'logo', href: '#/' }, h('i', { html: svgLogo }), 'BotForge');

function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 4200);
}
async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', ...(store.token ? { authorization: 'Bearer ' + store.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && store.token) { store.token = null; ME = null; location.hash = '#/login'; }
  if (!res.ok) throw new Error(j.error || 'خطأ ' + res.status);
  return j;
}
function busy(btn, fn) {
  return async (e) => {
    if (btn.disabled) return;
    const old = btn.innerHTML; btn.disabled = true; btn.prepend(h('span', { class: 'spin' }), ' ');
    try { await fn(e); } catch (err) { toast(err.message, 'bad'); } finally { btn.disabled = false; btn.innerHTML = old; }
  };
}
function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const b = new Uint8Array(r.result); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); res(btoa(s)); };
    r.onerror = rej; r.readAsArrayBuffer(file);
  });
}
const pad = (n) => String(n).padStart(2, '0');
const hhmmss = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
function fmtUp(ms) { const s = Math.floor(ms / 1000); if (s < 60) return s + ' ث'; if (s < 3600) return Math.floor(s / 60) + ' د'; if (s < 86400) return Math.floor(s / 3600) + ' س ' + Math.floor(s % 3600 / 60) + ' د'; return Math.floor(s / 86400) + ' يوم'; }
const STATUS_AR = { running: 'يعمل', stopped: 'متوقف', error: 'به خطأ', busy: 'جاري...' };
const statusEl = (s) => h('span', { class: 'st' }, h('i', { class: 'dot ' + s }), STATUS_AR[s] || s);
function modal(title, body, actions) {
  const m = h('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, h('div', { class: 'mbox' }, h('h2', {}, title), body, actions ? h('div', { class: 'acts' }, actions) : null));
  document.body.append(m); return m;
}

// ---------- الراوتر ----------
async function boot() {
  if (store.token && !ME) { try { ME = (await api('GET', '/me')); } catch { store.token = null; } }
  route();
}
window.addEventListener('hashchange', route);
async function route() {
  cleanup.forEach((f) => { try { f(); } catch {} }); cleanup = [];
  const hash = location.hash || '#/';
  if (store.token && !ME) { try { ME = await api('GET', '/me'); } catch {} }
  if (hash.startsWith('#/app')) {
    if (!store.token || !ME) { location.hash = '#/login'; return; }
    const m = hash.match(/^#\/app\/bot\/([\w]+)(?:\/(\w+))?/);
    if (m) return botView(m[1], m[2] || 'console');
    if (hash.startsWith('#/app/help')) return helpView();
    return botsView();
  }
  if (hash === '#/login' || hash === '#/register') { if (store.token && ME) { location.hash = '#/app'; return; } return authView(hash === '#/register'); }
  landing();
}
function mount(...nodes) { $app.replaceChildren(...nodes); window.scrollTo(0, 0); }

// ---------- الصفحة الرئيسية ----------
function landing() {
  document.title = 'BotForge — استضافة بوتات تيليجرام';
  const feats = [
    ['⚡', 'تشغيل وفحص بضغطة واحدة', 'فحص حقيقي للكود بمترجم اللغة، تثبيت المكتبات تلقائياً، ثم تشغيل البوت مع نتيجة واضحة وسطر الخطأ.'],
    ['🤖', 'أنشئ بوتك بالذكاء الاصطناعي', 'اكتب وصفاً بالعربي، والنظام يولّد الكود ويجرّبه ويصلح أخطاءه تلقائياً حتى يعمل.'],
    ['📡', 'لوجات حية', 'شاشة Console تعرض مخرجات البوت لحظة بلحظة، مع حالة حية واستهلاك CPU/RAM.'],
    ['🧩', 'محرر VS Code مدمج', 'محرر Monaco بتلوين الأخطاء. عدّل وإحفظ (Ctrl+S) وأعد التشغيل بدون إعادة رفع.'],
    ['🔒', 'عزل وأمان', 'كل بوت بعملية منفصلة أو حاوية Docker، توكنات مشفّرة، وكل مستخدم يرى بوتاته فقط.'],
    ['🗂', 'ربط ذكي للملفات', 'الملف الرئيسي ومجلد الإضافات يُربطان بمعرّف مشروع داخلي — انقلهما كما تشاء ولا ينكسر شيء.'],
  ];
  mount(
    h('nav', { class: 'nav' }, logo(), h('div', { class: 'links' },
      store.token ? h('a', { class: 'btn pri', href: '#/app' }, 'لوحة التحكم') : [h('a', { class: 'btn ghost', href: '#/login' }, 'دخول'), h('a', { class: 'btn pri', href: '#/register' }, 'ابدأ مجاناً')])),
    h('header', { class: 'hero' },
      h('span', { class: 'pill' }, h('b', {}, 'Python'), '·', h('b', {}, 'Node.js'), '· بيئة معزولة'),
      h('h1', {}, 'شغّل بوتات تيليجرام ', h('em', {}, 'بدون سيرفر ولا تعقيد')),
      h('p', {}, 'ارفع ملف البوت أو اطلب من الذكاء الاصطناعي كتابته. نفحص الكود، نثبّت المكتبات، ونشغّله لك على مدار الساعة.'),
      h('div', { class: 'cta' }, h('a', { class: 'btn pri lg', href: store.token ? '#/app' : '#/register' }, 'أنشئ أول بوت'), h('a', { class: 'btn lg', href: '#how' , onclick: (e) => { e.preventDefault(); document.getElementById('how').scrollIntoView({ behavior: 'smooth' }); } }, 'كيف يعمل؟')),
      h('div', { class: 'term' }, h('div', { class: 'bar' }, h('s'), h('s'), h('s')),
        h('pre', { html: `<span class="d">$</span> <span class="g">تشغيل وفحص</span>\n<span class="g">✓</span> 1/4 التوكن صالح — @my_shop_bot\n<span class="g">✓</span> 2/4 بنية الكود سليمة\n<span class="g">✓</span> 3/4 تثبيت: python-telegram-bot\n<span class="g">✓</span> 4/4 البوت يعمل\n<span class="d">12:04:11</span> <span class="y">[bot]</span> polling started\n<span class="d">12:04:19</span> <span class="y">[bot]</span> /start from user 48211` }))),
    h('section', { class: 'sec' }, h('h2', {}, 'كل ما تحتاجه لاستضافة بوت'), h('p', { class: 'sub' }, 'منصة واحدة من الرفع إلى التشغيل والمراقبة'),
      h('div', { class: 'grid' }, feats.map(([i, t, d]) => h('div', { class: 'card' }, h('div', { class: 'ic' }, i), h('h3', {}, t), h('p', {}, d))))),
    h('section', { class: 'sec', id: 'how' }, h('h2', {}, 'ثلاث خطوات'), h('p', { class: 'sub' }, 'من الفكرة إلى بوت يعمل'),
      h('div', { class: 'steps' }, [['أنشئ مشروعاً', 'ارفع ملفك الرئيسي ومجلد الإضافات، أو اكتب وصف البوت ليولّده الذكاء الاصطناعي.'], ['أضف التوكن', 'الصق توكن BotFather — نتحقق منه مباشرة مع تيليجرام.'], ['اضغط «تشغيل وفحص»', 'نفحص ونثبّت ونشغّل، وتشاهد كل شيء في الـ Console لحظياً.']].map(([t, d]) => h('div', { class: 'card' }, h('h3', {}, t), h('p', {}, d))))),
    h('section', { class: 'sec', style: 'text-align:center' }, h('h2', {}, 'جاهز تبدأ؟'), h('p', { class: 'sub' }, 'سجّل حساباً وشغّل بوتك خلال دقائق.'), h('a', { class: 'btn pri lg', href: store.token ? '#/app' : '#/register' }, 'ابدأ الآن')),
    h('footer', { class: 'foot' }, 'BotForge © ' + new Date().getFullYear()));
}

// ---------- الدخول والتسجيل ----------
function authView(isReg) {
  document.title = (isReg ? 'حساب جديد' : 'تسجيل الدخول') + ' — BotForge';
  const err = h('div', { class: 'err', style: 'display:none' });
  const name = h('input', { class: 'in', placeholder: 'الاسم', autocomplete: 'name' });
  const email = h('input', { class: 'in mono', type: 'email', placeholder: 'you@email.com', autocomplete: 'email', style: 'text-align:left' });
  const pw = h('input', { class: 'in mono', type: 'password', placeholder: '••••••••', autocomplete: isReg ? 'new-password' : 'current-password', style: 'text-align:left' });
  const btn = h('button', { class: 'btn pri', style: 'width:100%' }, isReg ? 'إنشاء الحساب' : 'دخول');
  const submit = busy(btn, async () => {
    err.style.display = 'none';
    try {
      const r = await api('POST', isReg ? '/auth/register' : '/auth/login', { name: name.value, email: email.value, password: pw.value });
      store.token = r.token; ME = null; await boot(); location.hash = '#/app';
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  });
  btn.addEventListener('click', submit);
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    err, isReg ? h('label', { class: 'f' }, h('span', {}, 'الاسم'), name) : null,
    h('label', { class: 'f' }, h('span', {}, 'البريد الإلكتروني'), email),
    h('label', { class: 'f' }, h('span', {}, 'كلمة المرور' + (isReg ? ' (8 أحرف على الأقل)' : '')), pw), btn);
  mount(h('div', { class: 'authwrap' }, h('div', { class: 'authbox' }, logo(), h('h1', {}, isReg ? 'أنشئ حسابك' : 'أهلاً بعودتك'), h('p', { class: 's' }, isReg ? 'ابدأ باستضافة بوتاتك' : 'سجّل الدخول للوصول إلى بوتاتك'), form,
    h('p', { class: 'hint', style: 'text-align:center;margin-top:16px' }, isReg ? 'لديك حساب؟ ' : 'ليس لديك حساب؟ ', h('a', { href: isReg ? '#/login' : '#/register', style: 'color:var(--acc)' }, isReg ? 'سجّل دخولك' : 'أنشئ حساباً')))));
}

// ---------- الهيكل (قائمة جانبية) ----------
function shell(active, title, actions, content) {
  const links = [['#/app', 'bots', '🤖', 'بوتاتي'], ['#/app/help', 'help', '📖', 'الدليل']];
  const logout = () => { store.token = null; ME = null; location.hash = '#/'; };
  const side = h('aside', { class: 'side' }, logo(), links.map(([href, k, ic, t]) => h('a', { href, class: active === k ? 'on' : '' }, ic, t)), h('div', { class: 'sp' }), h('button', { class: 'nl', onclick: logout }, '🚪 خروج'), h('div', { class: 'me' }, ME?.user?.name + ' · ' + ME?.user?.email));
  const mnav = h('div', { class: 'mnav' }, links.map(([href, k, , t]) => h('a', { href, class: active === k ? 'on' : '' }, t)), h('button', { onclick: logout }, 'خروج'));
  mount(h('div', { class: 'shell' }, side, h('div', { class: 'main' }, mnav, h('div', { class: 'top' }, h('h1', {}, title), h('div', { class: 'row' }, actions)), h('div', { class: 'page' }, content))));
}

// ---------- قائمة البوتات ----------
async function botsView() {
  document.title = 'بوتاتي — BotForge';
  const list = h('div', { class: 'bots' });
  const newBtn = h('button', { class: 'btn', onclick: newBotModal }, '＋ بوت جديد');
  const aiBtn = h('button', { class: 'btn pri', onclick: aiModal }, '✨ أنشئ بوت بالذكاء الاصطناعي');
  shell('bots', 'بوتاتي', [newBtn, aiBtn], list);
  let alive = true; cleanup.push(() => { alive = false; });
  async function load() {
    let bots; try { bots = await api('GET', '/bots'); } catch (e) { return; }
    if (!alive) return;
    if (!bots.length) {
      list.replaceChildren(h('div', { class: 'empty', style: 'grid-column:1/-1' }, h('h3', {}, 'لا توجد بوتات بعد'), h('p', {}, 'أنشئ أول بوت: ارفع ملفاً أو دع الذكاء الاصطناعي يكتبه لك.'), h('div', { class: 'row', style: 'justify-content:center;margin-top:16px' }, h('button', { class: 'btn', onclick: newBotModal }, 'رفع بوت'), h('button', { class: 'btn pri', onclick: aiModal }, '✨ بالذكاء الاصطناعي'))));
      return;
    }
    list.replaceChildren(...bots.map((b) => h('a', { class: 'bot', href: '#/app/bot/' + b.id },
      h('h3', {}, b.name), h('div', {}, statusEl(b.status)),
      h('div', { class: 'm' }, h('span', { class: 'tag' }, b.language === 'node' ? 'Node.js' : 'Python'), b.token_username ? h('span', { class: 'mono' }, '@' + b.token_username) : h('span', {}, 'بدون توكن'),
        b.stats?.running ? [h('span', {}, 'CPU ' + (b.stats.cpu ?? 0) + '%'), h('span', {}, 'RAM ' + (b.stats.ram_mb ?? 0) + 'MB')] : null))));
  }
  await load();
  const iv = setInterval(load, 5000); cleanup.push(() => clearInterval(iv));
}
function newBotModal() {
  const name = h('input', { class: 'in', placeholder: 'اسم البوت', maxlength: 60 });
  let lang = 'python';
  const seg = h('div', { class: 'seg' }, [['python', 'Python'], ['node', 'Node.js']].map(([k, t]) => h('button', { type: 'button', class: k === lang ? 'on' : '', onclick: (e) => { lang = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); } }, t)));
  const ok = h('button', { class: 'btn pri' }, 'إنشاء');
  const m = modal('بوت جديد', h('div', {}, h('label', { class: 'f' }, h('span', {}, 'الاسم'), name), h('label', { class: 'f' }, h('span', {}, 'اللغة'), seg)), [ok, h('button', { class: 'btn ghost', onclick: () => m.remove() }, 'إلغاء')]);
  ok.addEventListener('click', busy(ok, async () => { const b = await api('POST', '/bots', { name: name.value, language: lang }); m.remove(); location.hash = '#/app/bot/' + b.id + '/files'; }));
  name.focus();
}
function aiModal() {
  const desc = h('textarea', { class: 'in', placeholder: 'مثال: بوت أزرار فيه آلة حاسبة يجمع ويطرح ويضرب ويقسم' });
  const token = h('input', { class: 'in mono', placeholder: '123456:ABC... (اختياري — لتشغيل البوت وتجربته فعلياً)', style: 'text-align:left' });
  let lang = 'python';
  const seg = h('div', { class: 'seg' }, [['python', 'Python'], ['node', 'Node.js']].map(([k, t]) => h('button', { type: 'button', class: k === lang ? 'on' : '', onclick: (e) => { lang = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); } }, t)));
  const ok = h('button', { class: 'btn pri' }, '✨ ولّد وجرّب');
  const warn = ME?.ai ? null : h('div', { class: 'warn' }, 'الذكاء الاصطناعي غير مفعّل على هذا الخادم. اضبط AI_API_KEY في إعدادات الخادم (انظر الدليل).');
  const m = modal('أنشئ بوت بالذكاء الاصطناعي', h('div', {}, warn, h('label', { class: 'f' }, h('span', {}, 'وصف البوت'), desc), h('label', { class: 'f' }, h('span', {}, 'اللغة'), seg),
    h('label', { class: 'f' }, h('span', {}, 'توكن BotFather'), token, h('div', { class: 'hint' }, 'بدون توكن: يُولَّد الكود ويُفحص وتُثبَّت مكتباته فقط. مع التوكن: يُشغَّل أيضاً ويُصلَح لو انهار.'))),
    [ok, h('button', { class: 'btn ghost', onclick: () => m.remove() }, 'إلغاء')]);
  ok.addEventListener('click', busy(ok, async () => { const r = await api('POST', '/ai/generate', { description: desc.value, language: lang, token: token.value }); m.remove(); location.hash = '#/app/bot/' + r.bot_id + '/console'; }));
  desc.focus();
}

// ---------- محرر Monaco (مع بديل textarea) ----------
let monacoP = null;
function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (monacoP) return monacoP;
  const base = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VER}/min/vs`;
  monacoP = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 12000);
    const s = document.createElement('script'); s.src = base + '/loader.js';
    s.onload = () => {
      window.MonacoEnvironment = { getWorkerUrl: () => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(`self.MonacoEnvironment={baseUrl:'${base}/../'};importScripts('${base}/base/worker/workerMain.js');`) };
      window.require.config({ paths: { vs: base } });
      window.require(['vs/editor/editor.main'], () => { clearTimeout(t); resolve(window.monaco); }, () => resolve(null));
    };
    s.onerror = () => { clearTimeout(t); resolve(null); };
    document.head.append(s);
  });
  return monacoP;
}
const LANG_OF = { py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', txt: 'plaintext', yml: 'yaml', yaml: 'yaml', html: 'html', css: 'css', sh: 'shell', env: 'plaintext' };
async function makeEditor(container, onSave, onChange) {
  const monaco = await loadMonaco();
  if (monaco) {
    const ed = monaco.editor.create(container, { value: '', language: 'plaintext', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 14, fontFamily: "'JetBrains Mono', monospace", scrollBeyondLastLine: false, tabSize: 4, padding: { top: 10 } });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
    ed.onDidChangeModelContent(() => onChange());
    return {
      kind: 'monaco', get: () => ed.getValue(),
      set(v, path) { const model = monaco.editor.createModel(v, LANG_OF[path.split('.').pop().toLowerCase()] || 'plaintext'); const old = ed.getModel(); ed.setModel(model); old && old.dispose(); },
      mark(line, msg) { const m = ed.getModel(); monaco.editor.setModelMarkers(m, 'bf', line ? [{ severity: monaco.MarkerSeverity.Error, message: msg || 'خطأ', startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: m.getLineMaxColumn(Math.min(line, m.getLineCount())) }] : []); if (line) { ed.revealLineInCenter(line); ed.setPosition({ lineNumber: line, column: 1 }); ed.focus(); } },
    };
  }
  const ta = h('textarea', { spellcheck: 'false', oninput: onChange, onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); onSave(); } if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('    ', s, ta.selectionEnd, 'end'); onChange(); } } });
  container.append(ta);
  return { kind: 'plain', get: () => ta.value, set(v) { ta.value = v; }, mark(line) { if (!line) return; const lines = ta.value.split('\n'); let pos = 0; for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1; ta.focus(); ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length); } };
}

// ---------- صفحة البوت ----------
async function botView(id, tab) {
  let bot;
  try { bot = await api('GET', '/bots/' + id); } catch (e) { toast(e.message, 'bad'); location.hash = '#/app'; return; }
  document.title = bot.name + ' — BotForge';
  const state = { bot, es: null, ed: null, files: [], cur: null, dirty: false, openDirs: new Set(), alive: true, running: false };
  cleanup.push(() => { state.alive = false; state.es?.close(); });

  const title = h('span', {}, bot.name);
  const head = h('span', { class: 'row', style: 'gap:14px' }, title, statusEl(bot.status));
  const tabs = h('div', { class: 'tabs' }, [['console', '📟 التحكم والـ Console'], ['files', '🧩 الملفات والمحرر'], ['settings', '⚙️ الإعدادات']].map(([k, t]) => h('a', { href: `#/app/bot/${id}/${k}`, class: k === tab ? 'on' : '' }, t)));
  const content = h('div');
  shell('bots', head, [h('a', { class: 'btn ghost', href: '#/app' }, '← كل البوتات')], h('div', {}, tabs, content));
  const setHeadStatus = (s) => { state.bot.status = s; head.replaceChildren(title, statusEl(s)); };

  // ---- SSE مشترك ----
  const consoleBox = h('div', { class: 'console', dir: 'ltr' });
  const resultBox = h('div');
  const addLine = (e) => {
    const near = consoleBox.scrollHeight - consoleBox.scrollTop - consoleBox.clientHeight < 60;
    consoleBox.append(h('div', { class: 'l ' + e.s }, h('span', { class: 't' }, hhmmss(e.t)), h('span', { class: 'mm' }, e.m)));
    while (consoleBox.childElementCount > 1200) consoleBox.firstChild.remove();
    if (near) consoleBox.scrollTop = consoleBox.scrollHeight;
  };
  function showResult(r) {
    if (!r) { resultBox.replaceChildren(); return; }
    if (r.ok) { resultBox.replaceChildren(h('div', { class: 'result ok' }, h('h4', {}, '✅ نجح التشغيل'), h('div', { class: 'hint' }, r.note || ('البوت @' + (r.username || state.bot.token_username || '') + ' يعمل الآن')))); return; }
    const e = r.error || {};
    const STAGES = { token: 'التوكن', syntax: 'بنية الكود', deps: 'المكتبات', runtime: 'التشغيل', files: 'الملفات' };
    resultBox.replaceChildren(h('div', { class: 'result bad' }, h('h4', {}, '❌ فشل — مرحلة ' + (STAGES[r.stage] || r.stage || '')),
      h('div', { dir: 'auto' }, e.message || 'خطأ غير معروف'),
      e.file && e.line ? h('div', { style: 'margin-top:6px' }, 'الموقع: ', h('a', { class: 'mono', onclick: () => { state.goto = { file: e.file, line: e.line, msg: e.message }; location.hash = `#/app/bot/${id}/files`; } }, `${e.file}:${e.line}`), ' (اضغط للانتقال للمحرر)') : null,
      e.text ? h('pre', {}, e.text) : null, (e.detail || r.output) ? h('pre', {}, e.detail || r.output) : null));
    if (e.file && e.line) state.lastErr = e;
  }
  function connect() {
    const es = new EventSource(`/api/bots/${id}/stream?token=${encodeURIComponent(store.token)}`);
    state.es = es;
    es.addEventListener('backlog', (ev) => { const d = JSON.parse(ev.data); consoleBox.replaceChildren(); d.logs.forEach(addLine); consoleBox.scrollTop = consoleBox.scrollHeight; });
    es.addEventListener('log', (ev) => addLine(JSON.parse(ev.data)));
    es.addEventListener('event', (ev) => {
      const d = JSON.parse(ev.data);
      if (d.type === 'status') setHeadStatus(d.status);
      else if (d.type === 'result') showResult(d.result);
      else if (d.type === 'crash') showResult({ ok: false, stage: 'runtime', error: d.error });
      else if (d.type === 'ai_done') { toast(d.ok ? '✨ انتهى الذكاء الاصطناعي' : 'توقف الذكاء الاصطناعي — راجع الـ Console', d.ok ? 'good' : 'bad'); api('GET', '/bots/' + id).then((b) => { state.bot = b; setHeadStatus(b.status); showResult(b.last_result); renderStats(); }); }
    });
  }
  connect();

  // ======== تبويب: التحكم ========
  async function renderConsole() {
    const cpu = h('b', {}, '—'), ram = h('b', {}, '—'), up = h('b', {}, '—');
    const cpuBar = h('i', { style: 'width:0%' }), ramBar = h('i', { style: 'width:0%' });
    const stat = (label, val, bar) => h('div', { class: 'stat' }, h('small', {}, label), val, bar ? h('div', { class: 'bar2' }, bar) : null);
    const runBtn = h('button', { class: 'btn pri' }, '▶ تشغيل وفحص');
    const stopBtn = h('button', { class: 'btn' }, '⏹ إيقاف');
    const startBtn = h('button', { class: 'btn' }, '▶ تشغيل سريع');
    const restartBtn = h('button', { class: 'btn' }, '↻ إعادة تشغيل');
    const delBtn = h('button', { class: 'btn danger' }, '🗑 حذف');
    const act = (btn, fn) => btn.addEventListener('click', busy(btn, fn));
    act(runBtn, async () => { setHeadStatus('busy'); resultBox.replaceChildren(); const r = await api('POST', `/bots/${id}/run`); showResult(r); const b = await api('GET', '/bots/' + id); state.bot = b; setHeadStatus(b.status); });
    act(startBtn, async () => { const r = await api('POST', `/bots/${id}/start`); if (!r.ok) showResult({ ok: false, stage: 'runtime', error: r.error, output: r.output }); const b = await api('GET', '/bots/' + id); setHeadStatus(b.status); });
    act(stopBtn, async () => { await api('POST', `/bots/${id}/stop`); setHeadStatus('stopped'); });
    act(restartBtn, async () => { const r = await api('POST', `/bots/${id}/restart`); if (!r.ok) showResult({ ok: false, stage: 'runtime', error: r.error, output: r.output }); else showResult(null); const b = await api('GET', '/bots/' + id); setHeadStatus(b.status); });
    act(delBtn, async () => { if (!confirm('حذف البوت وكل ملفاته نهائياً؟')) return; await api('DELETE', '/bots/' + id); toast('تم الحذف', 'good'); location.hash = '#/app'; });
    const warn = [];
    if (!state.bot.main_file) warn.push('لم يتم رفع الملف الرئيسي بعد — افتح تبويب «الملفات والمحرر».');
    if (!state.bot.has_token) warn.push('لم يتم إدخال التوكن — افتح تبويب «الإعدادات».');
    content.replaceChildren(...[
      warn.length ? h('div', { class: 'warn' }, warn.map((w) => h('div', {}, '⚠️ ' + w))) : null,
      h('div', { class: 'row', style: 'margin-bottom:16px' }, runBtn, startBtn, stopBtn, restartBtn, h('span', { style: 'flex:1' }), delBtn),
      h('div', { class: 'stats' }, stat('CPU', cpu, cpuBar), stat('RAM', ram, ramBar), stat('مدة التشغيل', up), stat('الملف الرئيسي', h('b', { class: 'mono', style: 'font-size:14px' }, state.bot.main_file || '—'))),
      resultBox, h('div', { class: 'cbar' }, h('b', {}, '📟 Console مباشر'), h('button', { class: 'btn sm ghost', onclick: () => consoleBox.replaceChildren() }, 'مسح العرض')), consoleBox].filter(Boolean));
    consoleBox.scrollTop = consoleBox.scrollHeight;
    showResult(state.bot.last_result && state.bot.status === 'error' ? state.bot.last_result : state.bot.last_result?.ok ? state.bot.last_result : null);
    renderStats = async () => {
      if (!state.alive) return;
      try {
        const s = await api('GET', `/bots/${id}/stats`);
        if (s.running) { cpu.textContent = s.cpu + '%'; ram.textContent = s.ram_mb + ' MB'; up.textContent = fmtUp(s.uptime); cpuBar.style.width = Math.min(100, s.cpu) + '%'; ramBar.style.width = Math.min(100, s.ram_mb / 512 * 100) + '%'; if (state.bot.status !== 'running') setHeadStatus('running'); }
        else { cpu.textContent = ram.textContent = up.textContent = '—'; cpuBar.style.width = ramBar.style.width = '0%'; }
      } catch {}
    };
    renderStats(); const iv = setInterval(() => renderStats(), 3000); cleanup.push(() => clearInterval(iv));
  }
  let renderStats = () => {};

  // ======== تبويب: الملفات والمحرر ========
  async function renderFiles() {
    const tree = h('div', { class: 'tree' });
    const saveBtn = h('button', { class: 'btn pri sm' }, '💾 حفظ (Ctrl+S)');
    const checkBtn = h('button', { class: 'btn sm' }, '🔍 فحص الكود');
    const curName = h('span', { class: 'mono', style: 'font-size:13px' }, 'اختر ملفاً');
    const dirtyDot = h('span', { style: 'color:var(--yel);display:none' }, '●');
    const edBox = h('div', { class: 'edbox' });
    const mainIn = h('input', { type: 'file', accept: '.py,.js,.mjs,.cjs', style: 'display:none' });
    const extraIn = h('input', { type: 'file', multiple: true, style: 'display:none' });
    const dirIn = h('input', { type: 'file', multiple: true, webkitdirectory: true, style: 'display:none' });
    const mainInfo = h('div', { class: 'hint mono' }, state.bot.main_file ? 'الحالي: ' + state.bot.main_file : 'لم يُرفع بعد');
    const upload = h('div', { class: 'two' },
      h('div', { class: 'panel', style: 'margin:0' }, h('h3', {}, '📄 ملف البوت الرئيسي'), h('div', { class: 'drop', onclick: () => mainIn.click() }, 'اضغط لاختيار main.py أو index.js'), mainInfo),
      h('div', { class: 'panel', style: 'margin:0' }, h('h3', {}, '📁 ملفات ومجلدات إضافية'), h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => extraIn.click() }, 'ملفات (requirements.txt, صور...)'), h('button', { class: 'btn sm', onclick: () => dirIn.click() }, 'مجلد كامل')), h('div', { class: 'hint' }, 'تُربط تلقائياً بالمشروع عبر معرّف داخلي، ويمكنك نقلها من الشجرة بدون كسر الربط.')));
    const edWrap = h('div', { class: 'edwrap' }, h('div', { class: 'edhead' }, h('div', { class: 'row', style: 'gap:8px' }, curName, dirtyDot), h('div', { class: 'row' }, checkBtn, saveBtn)), edBox);
    content.replaceChildren(h('div', { style: 'margin-bottom:16px' }, upload, mainIn, extraIn, dirIn), h('div', { class: 'ed' }, tree, edWrap));

    const markDirty = (d) => { state.dirty = d; dirtyDot.style.display = d ? '' : 'none'; };
    let ed = null; // يُنشأ بعد ربط كل الأحداث (تحميل Monaco غير متزامن)

    async function loadFiles() { state.files = (await api('GET', `/bots/${id}/files`)).files; renderTree(); }
    function renderTree() {
      const rows = []; const dirs = new Set();
      for (const f of state.files) { const parts = f.path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
      const entries = [...[...dirs].map((d) => ({ path: d, dir: true })), ...state.files].sort((a, b) => a.path.localeCompare(b.path));
      for (const e of entries) {
        const parts = e.path.split('/'); const depth = parts.length - 1;
        let hidden = false; for (let i = 1; i < parts.length; i++) if (!state.openDirs.has(parts.slice(0, i).join('/'))) hidden = true;
        if (hidden) continue;
        const isMain = !e.dir && e.path === state.bot.main_file;
        const canMain = !e.dir && /\.(py|js|mjs|cjs)$/.test(e.path) && !isMain;
        rows.push(h('div', { class: 'it' + (state.cur === e.path ? ' on' : ''), style: `padding-inline-start:${8 + depth * 14}px`, onclick: () => (e.dir ? (state.openDirs.has(e.path) ? state.openDirs.delete(e.path) : state.openDirs.add(e.path), renderTree()) : openFile(e.path)) },
          h('span', {}, e.dir ? (state.openDirs.has(e.path) ? '📂' : '📁') : '📄'), h('span', { class: 'nm', title: e.path }, parts[parts.length - 1]), isMain ? h('span', { class: 'main-b' }, 'MAIN') : null,
          h('span', { class: 'ac' },
            canMain ? h('button', { title: 'تعيين كملف رئيسي', onclick: async (ev) => { ev.stopPropagation(); try { state.bot = await api('PUT', `/bots/${id}/main`, { path: e.path }); mainInfo.textContent = 'الحالي: ' + e.path; renderTree(); toast('تم تعيين الملف الرئيسي', 'good'); } catch (er) { toast(er.message, 'bad'); } } }, '⭐') : null,
            h('button', { title: 'نقل / إعادة تسمية', onclick: async (ev) => { ev.stopPropagation(); const to = prompt('المسار الجديد:', e.path); if (!to || to === e.path) return; try { const r = await api('POST', `/bots/${id}/move`, { from: e.path, to }); state.bot.main_file = r.main_file; if (state.cur === e.path) state.cur = to; const tp = to.split('/'); for (let i = 1; i < tp.length; i++) state.openDirs.add(tp.slice(0, i).join('/')); mainInfo.textContent = 'الحالي: ' + (r.main_file || '—'); await loadFiles(); toast('تم النقل — الربط محفوظ', 'good'); } catch (er) { toast(er.message, 'bad'); } } }, '✎'),
            h('button', { title: 'حذف', onclick: async (ev) => { ev.stopPropagation(); if (!confirm('حذف ' + e.path + '؟')) return; try { await api('DELETE', `/bots/${id}/file?path=${encodeURIComponent(e.path)}`); if (state.cur === e.path) { state.cur = null; curName.textContent = 'اختر ملفاً'; ed.set('', 'x.txt'); } await loadFiles(); } catch (er) { toast(er.message, 'bad'); } } }, '🗑'))));
      }
      tree.replaceChildren(h('div', { class: 'row', style: 'padding:4px 6px 8px' }, h('button', { class: 'btn sm', onclick: newFile }, '＋ ملف جديد')), ...(rows.length ? rows : [h('div', { class: 'hint', style: 'padding:10px' }, 'لا توجد ملفات بعد. ارفع الملف الرئيسي أو أنشئ ملفاً.')]));
    }
    async function newFile() { const p = prompt('مسار الملف (مثال: main.py أو utils/helpers.py):'); if (!p) return; try { await api('PUT', `/bots/${id}/file`, { path: p, content: '' }); await loadFiles(); openFile(p); } catch (e) { toast(e.message, 'bad'); } }
    async function openFile(p, line, msg) {
      if (!ed) return;
      if (state.dirty && state.cur !== p && !confirm('لديك تغييرات غير محفوظة. تجاهلها؟')) return;
      try {
        state.loading = true;
        const f = await api('GET', `/bots/${id}/file?path=${encodeURIComponent(p)}`);
        state.cur = p; curName.textContent = p; ed.set(f.content, p); markDirty(false); state.loading = false;
        const parts = p.split('/'); for (let i = 1; i < parts.length; i++) state.openDirs.add(parts.slice(0, i).join('/'));
        renderTree(); ed.mark(line || 0, msg);
      } catch (e) { state.loading = false; toast(e.message, 'bad'); }
    }
    async function save() {
      if (!ed || !state.cur) return toast('لا يوجد ملف مفتوح');
      await api('PUT', `/bots/${id}/file`, { path: state.cur, content: ed.get() }); markDirty(false); ed.mark(0); toast('تم الحفظ ✓ — أعد التشغيل لتطبيق التغييرات', 'good');
    }
    saveBtn.addEventListener('click', busy(saveBtn, save));
    checkBtn.addEventListener('click', busy(checkBtn, async () => {
      if (state.dirty) await save();
      const r = await api('POST', `/bots/${id}/check`);
      if (r.ok) { ed.mark(0); toast('✅ لا توجد أخطاء في بنية الكود', 'good'); }
      else { const e = r.errors[0]; toast(`❌ ${e.file}:${e.line} — ${e.message}`, 'bad'); await openFile(e.file, e.line, e.message); }
    }));
    mainIn.addEventListener('change', async () => {
      const f = mainIn.files[0]; if (!f) return;
      try { state.bot = await api('POST', `/bots/${id}/main`, { name: f.name, content_b64: await fileToB64(f) }); mainInfo.textContent = 'الحالي: ' + state.bot.main_file; await loadFiles(); openFile(state.bot.main_file); toast('تم رفع الملف الرئيسي', 'good'); } catch (e) { toast(e.message, 'bad'); }
      mainIn.value = '';
    });
    const uploadMany = async (input) => {
      const list = [...input.files]; if (!list.length) return;
      try {
        const files = []; for (const f of list) files.push({ path: f.webkitRelativePath || f.name, content_b64: await fileToB64(f) });
        const r = await api('POST', `/bots/${id}/files`, { files }); await loadFiles(); toast(`تم رفع ${r.count} ملف`, 'good');
      } catch (e) { toast(e.message, 'bad'); }
      input.value = '';
    };
    extraIn.addEventListener('change', () => uploadMany(extraIn)); dirIn.addEventListener('change', () => uploadMany(dirIn));
    const bu = (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', bu); cleanup.push(() => window.removeEventListener('beforeunload', bu));

    ed = state.ed = await makeEditor(edBox, () => save(), () => { if (state.cur && !state.loading) markDirty(true); });
    if (ed.kind === 'plain') edBox.before(h('div', { class: 'hint', style: 'padding:6px 12px;background:var(--bg2)' }, 'تعذر تحميل Monaco (يحتاج إنترنت للمتصفح) — يعمل محرر نصي بسيط مؤقتاً.'));
    await loadFiles();
    const g = state.goto; state.goto = null;
    const target = g || (state.bot.main_file ? { file: state.bot.main_file } : null);
    if (target) { for (const p of target.file.split('/').slice(0, -1).reduce((a, s) => [...a, [...a.slice(-1), s].join('/')], [])) state.openDirs.add(p); await openFile(target.file, g?.line, g?.msg); }
  }

  // ======== تبويب: الإعدادات ========
  function renderSettings() {
    const tok = h('input', { class: 'in mono', type: 'password', placeholder: state.bot.has_token ? '•••••••• (محفوظ — الصق توكناً جديداً لتغييره)' : '123456789:ABCdef...', style: 'text-align:left', autocomplete: 'off' });
    const tokBtn = h('button', { class: 'btn pri' }, 'تحقق واحفظ');
    const info = h('div', { class: 'hint' }, state.bot.token_username ? ['البوت المرتبط: ', h('b', { class: 'mono' }, '@' + state.bot.token_username)] : 'احصل على التوكن من @BotFather في تيليجرام.');
    tokBtn.addEventListener('click', busy(tokBtn, async () => { const r = await api('PUT', `/bots/${id}/token`, { token: tok.value }); tok.value = ''; state.bot.has_token = true; state.bot.token_username = r.username; info.replaceChildren('✅ التوكن صالح — البوت: ', h('b', { class: 'mono' }, '@' + r.username)); tok.placeholder = '•••••••• (محفوظ)'; toast('تم حفظ التوكن', 'good'); }));
    const nm = h('input', { class: 'in', value: state.bot.name, maxlength: 60 });
    const nmBtn = h('button', { class: 'btn' }, 'حفظ الاسم');
    nmBtn.addEventListener('click', busy(nmBtn, async () => { const b = await api('PUT', '/bots/' + id, { name: nm.value }); title.textContent = b.name; state.bot.name = b.name; toast('تم', 'good'); }));
    content.replaceChildren(
      h('div', { class: 'panel' }, h('h3', {}, '🔑 توكن البوت (BotFather)'), h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:240px' }, tok), tokBtn), info,
        h('div', { class: 'hint' }, 'يُتحقق منه عبر Telegram getMe، ويُخزَّن مشفّراً (AES-256-GCM)، ويصل للبوت كمتغير بيئة ', h('code', {}, 'BOT_TOKEN'), '. لا يظهر في اللوجات.')),
      h('div', { class: 'panel' }, h('h3', {}, '✏️ اسم المشروع'), h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:240px' }, nm), nmBtn)),
      h('div', { class: 'panel' }, h('h3', {}, 'ℹ️ معلومات'), h('div', { class: 'hint mono', style: 'line-height:2' }, `Project ID: ${id}`, h('br'), `Language: ${state.bot.language}`, h('br'), `Main: ${state.bot.main_file || '—'}`)));
  }

  if (tab === 'files') await renderFiles(); else if (tab === 'settings') renderSettings(); else await renderConsole();
}

// ---------- الدليل ----------
function helpView() {
  document.title = 'الدليل — BotForge';
  const code = (s) => h('pre', { class: 'mono', style: 'background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:13px;margin-top:8px' }, s);
  shell('help', 'الدليل', [], h('div', {},
    h('div', { class: 'panel' }, h('h3', {}, 'كيف يستلم بوتك التوكن؟'), h('p', { class: 'hint' }, 'لا تكتب التوكن داخل الكود. اقرأه من متغير البيئة ', h('code', {}, 'BOT_TOKEN'), ' (أو ', h('code', {}, 'TELEGRAM_BOT_TOKEN'), '):'),
      code('# Python\nimport os\nTOKEN = os.environ["BOT_TOKEN"]\n\n// Node.js\nconst TOKEN = process.env.BOT_TOKEN;')),
    h('div', { class: 'panel' }, h('h3', {}, 'المكتبات'), h('p', { class: 'hint' }, 'ضع ', h('code', {}, 'requirements.txt'), ' (بايثون) أو ', h('code', {}, 'package.json'), ' (Node). إن لم تضعهما، نكتشف المكتبات الناقصة من أوامر import/require ونثبّتها تلقائياً.')),
    h('div', { class: 'panel' }, h('h3', {}, 'ماذا يحدث عند «تشغيل وفحص»؟'), h('p', { class: 'hint', style: 'line-height:2' }, '1) التحقق من التوكن عبر getMe  ←  2) فحص syntax بمترجم اللغة  ←  3) فحص وتثبيت المكتبات  ←  4) التشغيل ومراقبته 4 ثوانٍ للتأكد من أنه لا ينهار.')),
    h('div', { class: 'panel' }, h('h3', {}, 'الملف الرئيسي والمجلد'), h('p', { class: 'hint' }, 'الملف الرئيسي مرتبط بالمشروع داخلياً (Project ID). يمكنك نقله أو إعادة تسميته أو نقل مجلد الإضافات من شجرة الملفات، ويتحدّث الربط تلقائياً.'))));
}

boot();
