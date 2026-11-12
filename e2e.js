const B = 'http://127.0.0.1:3100/api';
const GOOD = '123456789:AAFakeTokenForTestingOnly_abcdefghij';
let pass = 0, failn = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { failn++; console.log('  ✗ FAIL:', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(tok, method, p, body) {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); j._s = r.status; return j;
}
const b64 = (s) => Buffer.from(s).toString('base64');
(async () => {
  console.log('Auth');
  const email = `u${Date.now()}@t.io`;
  let r = await api(null, 'POST', '/auth/register', { email, name: 'Ali', password: 'short' }); ok(r._s === 400, 'كلمة مرور قصيرة مرفوضة');
  r = await api(null, 'POST', '/auth/register', { email, name: 'Ali', password: 'password123' }); ok(r._s === 200 && r.token, 'تسجيل حساب');
  const T = r.token;
  r = await api(null, 'POST', '/auth/register', { email, name: 'Ali', password: 'password123' }); ok(r._s === 409, 'بريد مكرر مرفوض');
  r = await api(null, 'POST', '/auth/login', { email, password: 'wrongpass1' }); ok(r._s === 401, 'دخول بكلمة خاطئة مرفوض');
  r = await api(null, 'POST', '/auth/login', { email, password: 'password123' }); ok(r._s === 200 && r.token, 'تسجيل دخول');
  r = await api(null, 'GET', '/bots'); ok(r._s === 401, 'بدون JWT مرفوض');
  r = await api('abc.def.ghi', 'GET', '/bots'); ok(r._s === 401, 'JWT مزوّر مرفوض');
  const T2 = (await api(null, 'POST', '/auth/register', { email: 'o' + email, name: 'Omar', password: 'password123' })).token;

  console.log('Bots + isolation');
  const bot = await api(T, 'POST', '/bots', { name: 'bot1', language: 'python' }); ok(bot.id, 'إنشاء بوت', bot);
  r = await api(T2, 'GET', '/bots/' + bot.id); ok(r._s === 404, 'مستخدم آخر لا يرى البوت');
  r = await api(T2, 'GET', '/bots'); ok(Array.isArray(r) && r.length === 0, 'لوحة المستخدم الآخر فارغة');
  r = await api(T2, 'POST', `/bots/${bot.id}/run`); ok(r._s === 404, 'مستخدم آخر لا يشغّل البوت');

  console.log('Token');
  r = await api(T, 'PUT', `/bots/${bot.id}/token`, { token: 'garbage' }); ok(r._s === 400, 'توكن بصيغة خاطئة مرفوض');
  r = await api(T, 'PUT', `/bots/${bot.id}/token`, { token: '123456789:WrongTokenWrongTokenWrongToken' }); ok(r._s === 400 && /Unauthorized/.test(r.error), 'توكن مرفوض من تيليجرام (getMe)', r);
  r = await api(T, 'PUT', `/bots/${bot.id}/token`, { token: GOOD }); ok(r.ok && r.username === 'test_bot', 'توكن صالح يُحفظ');
  r = await api(T, 'GET', `/bots/${bot.id}`); ok(r.has_token && !JSON.stringify(r).includes(GOOD), 'التوكن لا يُرجع للواجهة');

  console.log('Upload + path safety');
  r = await api(T, 'POST', `/bots/${bot.id}/main`, { name: 'main.txt', content_b64: b64('x') }); ok(r._s === 400, 'ملف رئيسي بامتداد خاطئ مرفوض');
  r = await api(T, 'POST', `/bots/${bot.id}/main`, { name: 'main.py', content_b64: b64('import os\nprint("a"\nprint("b")\n') }); ok(r.main_file === 'main.py', 'رفع الملف الرئيسي');
  r = await api(T, 'POST', `/bots/${bot.id}/files`, { files: [{ path: 'assets/img.txt', content_b64: b64('img') }, { path: '../evil.txt', content_b64: b64('x') }] }); ok(r._s === 400, 'اختراق ../ مرفوض');
  r = await api(T, 'POST', `/bots/${bot.id}/files`, { files: [{ path: 'assets/img.txt', content_b64: b64('img') }, { path: 'lib/helper.py', content_b64: b64('def hi():\n    return "hi"\n') }] }); ok(r.count === 2, 'رفع ملفات إضافية بمجلدات');
  r = await api(T, 'GET', `/bots/${bot.id}/file?path=${encodeURIComponent('../../etc/passwd')}`); ok(r._s === 400, 'قراءة خارج المجلد مرفوضة');
  r = await api(T, 'GET', `/bots/${bot.id}/file?path=.botforge/log.txt`); ok(r._s === 400, 'المجلدات الداخلية محجوبة');

  console.log('Validate & Run: syntax error');
  r = await api(T, 'POST', `/bots/${bot.id}/run`); ok(r.ok === false && r.stage === 'syntax' && r.error.line === 2 && r.error.file === 'main.py', 'خطأ syntax مع رقم السطر 2', r.error);
  r = await api(T, 'GET', `/bots/${bot.id}`); ok(r.status === 'error', 'الحالة = error');

  console.log('Editor: save without re-upload');
  r = await api(T, 'PUT', `/bots/${bot.id}/file`, { path: 'main.py', content: 'import os, time\nimport nonexistent_pkg_xyz\nprint("started", flush=True)\ntime.sleep(60)\n' }); ok(r.ok, 'حفظ من المحرر');
  r = await api(T, 'GET', `/bots/${bot.id}/file?path=main.py`); ok(r.content.includes('nonexistent_pkg_xyz'), 'قراءة الملف المحفوظ');

  console.log('Validate & Run: missing library');
  r = await api(T, 'POST', `/bots/${bot.id}/run`); ok(r.ok === false && r.stage === 'deps' && /nonexistent_pkg_xyz/.test(r.error.message), 'مكتبة ناقصة مكتشفة وفشل التثبيت بوضوح', r.error);

  console.log('Validate & Run: runtime crash with line');
  await api(T, 'PUT', `/bots/${bot.id}/file`, { path: 'main.py', content: 'import os\nfrom lib.helper import hi\nprint(hi(), flush=True)\nx = {}\nprint(x["missing"])\n' });
  await api(T, 'POST', `/bots/${bot.id}/files`, { files: [{ path: 'lib/__init__.py', content_b64: b64('') }] });
  r = await api(T, 'POST', `/bots/${bot.id}/run`); ok(r.ok === false && r.stage === 'runtime' && r.error.line === 5 && /KeyError/.test(r.error.message), 'انهيار وقت التشغيل: السطر 5 + KeyError', r.error);

  console.log('Validate & Run: success + live logs + stats');
  await api(T, 'PUT', `/bots/${bot.id}/file`, { path: 'main.py', content: 'import os, time, urllib.request\nfrom lib.helper import hi\nBASE=os.environ["TELEGRAM_API_BASE"]; TOKEN=os.environ["BOT_TOKEN"]\nprint("started", hi(), flush=True)\nbuf=[0]*3000000\nwhile True:\n    urllib.request.urlopen(f"{BASE}/bot{TOKEN}/getUpdates").read()\n    x=sum(i*i for i in range(200000))\n' });
  // اشترك في SSE
  const sseLines = []; const ac = new AbortController();
  fetch(`${B}/bots/${bot.id}/stream?token=${T}`, { signal: ac.signal }).then(async (res) => { const rd = res.body.getReader(); const dec = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; sseLines.push(dec.decode(value)); } }).catch(() => {});
  r = await api(T, 'POST', `/bots/${bot.id}/run`); ok(r.ok === true && r.username === 'test_bot' && r.pid, '✅ نجح التشغيل', r);
  await sleep(2500);
  const st = await api(T, 'GET', `/bots/${bot.id}/stats`); ok(st.running && st.ram_mb > 5 && st.cpu >= 0, `CPU/RAM: ${st.cpu}% / ${st.ram_mb}MB`, st);
  const stream = sseLines.join('');
  ok(/event: log/.test(stream) && stream.includes('started hi'), 'اللوجات الحية تصل عبر SSE');
  ok(stream.includes('event: event') && stream.includes('"step"'), 'خطوات التشغيل تصل عبر SSE');
  r = await api(T, 'GET', `/bots/${bot.id}`); ok(r.status === 'running', 'الحالة = running');
  r = await api(T, 'GET', `/bots/${bot.id}/logs`); ok(r.logs.some((l) => l.m.includes('started hi')), 'سجل اللوجات محفوظ');
  ok(!JSON.stringify(r.logs).includes(GOOD), 'التوكن غير ظاهر في اللوجات');

  console.log('Move without breaking link');
  r = await api(T, 'POST', `/bots/${bot.id}/move`, { from: 'main.py', to: 'src/bot_main.py' }); ok(r.main_file === 'src/bot_main.py', 'نقل الملف الرئيسي يحدّث الربط تلقائياً', r);
  r = await api(T, 'POST', `/bots/${bot.id}/move`, { from: 'lib', to: 'src/lib' }); ok(r.ok, 'نقل مجلد الإضافات');
  await api(T, 'PUT', `/bots/${bot.id}/file`, { path: 'src/bot_main.py', content: 'import os, time, sys\nsys.path.insert(0, os.path.dirname(__file__))\nfrom lib.helper import hi\nprint("moved ok", hi(), flush=True)\ntime.sleep(300)\n' });

  console.log('Controls: stop / start / restart');
  r = await api(T, 'POST', `/bots/${bot.id}/stop`); ok(r.ok, 'إيقاف');
  let b = await api(T, 'GET', `/bots/${bot.id}`); ok(b.status === 'stopped', 'الحالة = stopped');
  r = await api(T, 'POST', `/bots/${bot.id}/start`); ok(r.ok && r.pid, 'تشغيل', r);
  r = await api(T, 'POST', `/bots/${bot.id}/restart`); ok(r.ok && r.pid, 'إعادة تشغيل', r);
  await sleep(500);
  r = await api(T, 'GET', `/bots/${bot.id}/logs`); ok(r.logs.some((l) => l.m.includes('moved ok hi')), 'بعد النقل يعمل بالمسار الجديد');
  // طابور: أوامر متزامنة لا تتعارض
  const burst = await Promise.all([api(T, 'POST', `/bots/${bot.id}/restart`), api(T, 'POST', `/bots/${bot.id}/stop`), api(T, 'POST', `/bots/${bot.id}/start`)]);
  ok(burst.every((x) => x.ok), 'الطابور: 3 أوامر متزامنة بدون تعارض', burst);
  b = await api(T, 'GET', `/bots/${bot.id}`); ok(b.status === 'running', 'الحالة النهائية سليمة بعد التزاحم');
  r = await api(T, 'POST', `/bots/${bot.id}/stop`);

  console.log('Node.js bot');
  const nb = await api(T, 'POST', '/bots', { name: 'node-bot', language: 'node' });
  await api(T, 'PUT', `/bots/${nb.id}/token`, { token: GOOD });
  await api(T, 'POST', `/bots/${nb.id}/main`, { name: 'index.js', content_b64: b64('const x = ;\n') });
  r = await api(T, 'POST', `/bots/${nb.id}/run`); ok(r.ok === false && r.stage === 'syntax' && r.error.line === 1 && /SyntaxError/.test(r.error.message), 'Node syntax check', r.error);
  await api(T, 'PUT', `/bots/${nb.id}/file`, { path: 'index.js', content: 'const https = require("node:http");\nconsole.log("node bot up", process.env.BOT_TOKEN ? "token-ok":"no-token");\nsetInterval(()=>{}, 1000);\n' });
  r = await api(T, 'POST', `/bots/${nb.id}/run`); ok(r.ok === true, 'Node bot يعمل', r);
  r = await api(T, 'GET', `/bots/${nb.id}/logs`); ok(r.logs.some((l) => l.m.includes('node bot up token-ok')), 'Node يستلم التوكن عبر البيئة');
  await api(T, 'POST', `/bots/${nb.id}/stop`);

  console.log('AI generate + self-fix loop');
  r = await api(T, 'POST', '/ai/generate', { description: 'بوت أزرار فيه آلة حاسبة', language: 'python', token: GOOD }); ok(r.bot_id, 'بدء مهمة الذكاء الاصطناعي', r);
  const aid = r.bot_id;
  let logs = [];
  for (let i = 0; i < 40; i++) { await sleep(500); logs = (await api(T, 'GET', `/bots/${aid}/logs`)).logs; if (logs.some((l) => /اكتمل|توقفت/.test(l.m))) break; }
  const txt = logs.map((l) => l.m).join('\n'); console.log(txt.split('\n').map((l) => '     | ' + l).join('\n'));
  ok(txt.includes('جاري توليد الكود'), 'خطوة التوليد ظهرت');
  ok(/Syntax error in main.py:2/.test(txt) || txt.includes('خطأ:'), 'التقط الخطأ في الكود المعطوب');
  ok(txt.includes('إرسال الخطأ للذكاء الاصطناعي'), 'أرسل الخطأ للنموذج');
  ok(txt.includes('تم تطبيق الإصلاح'), 'طبّق الإصلاح');
  ok(txt.includes('اكتمل: البوت جاهز ويعمل'), 'انتهت الحلقة بنجاح والبوت يعمل');
  const ab = await api(T, 'GET', `/bots/${aid}`); ok(ab.main_file === 'main.py' && ab.status === 'running', 'المشروع محفوظ ويعمل', ab);
  await api(T, 'POST', `/bots/${aid}/stop`);

  console.log('Delete');
  r = await api(T, 'DELETE', `/bots/${bot.id}`); ok(r.ok, 'حذف بوت');
  r = await api(T, 'GET', `/bots/${bot.id}`); ok(r._s === 404, 'اختفى بعد الحذف');
  ac.abort();
  console.log(`\n${pass} passed, ${failn} failed`); process.exit(failn ? 1 : 0);
})();
