const { chromium } = require('playwright');
const GOOD = '123456789:AAFakeTokenForTestingOnly_abcdefghij';
(async () => {
  const br = await chromium.launch(); const pg = await br.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
  const errs = []; pg.on('pageerror', (e) => errs.push('PAGEERR ' + e.message)); pg.on('console', (m) => { if (m.type() === 'error' && !/fonts\.|jsdelivr|ERR_|Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  const S = (n) => pg.screenshot({ path: `/tmp/bf-test/shots/${n}.png` });
  const step = (m) => console.log('•', m);
  await pg.goto('http://127.0.0.1:3100/'); await pg.waitForSelector('.hero'); await S('1-landing');
  step('landing ok');
  await pg.click('a[href="#/register"] >> nth=0');
  await pg.fill('input[placeholder="الاسم"]', 'علي'); await pg.fill('input[type=email]', `ui${Date.now()}@t.io`); await pg.fill('input[type=password]', 'password123');
  await S('2-register'); await pg.click('button:has-text("إنشاء الحساب")');
  await pg.waitForSelector('.empty'); step('registered -> dashboard empty state'); await S('3-dashboard-empty');
  await pg.click('button:has-text("بوت جديد")'); await pg.fill('.mbox input', 'بوت المتجر'); await pg.click('.mbox button:has-text("إنشاء")');
  await pg.waitForSelector('.ed'); step('bot created -> files tab');
  require('fs').writeFileSync('/tmp/bf-test/main.py', 'import os, time, urllib.request\nBASE=os.environ["TELEGRAM_API_BASE"]; T=os.environ["BOT_TOKEN"]\nprint("shop bot online", flush=True)\nwhile True:\n    urllib.request.urlopen(f"{BASE}/bot{T}/getUpdates").read()\n');
  require('fs').writeFileSync('/tmp/bf-test/requirements.txt', '');
  await pg.setInputFiles('input[accept=".py,.js,.mjs,.cjs"]', '/tmp/bf-test/main.py');
  await pg.waitForSelector('.tree .it:has-text("main.py")'); await pg.waitForSelector('.main-b');
  await pg.setInputFiles('input[type=file][multiple]:not([webkitdirectory])', '/tmp/bf-test/requirements.txt');
  await pg.waitForSelector('.tree .it:has-text("requirements.txt")'); step('uploaded main + extra');
  await pg.waitForFunction(() => document.querySelector('.edbox textarea, .edbox .monaco-editor')?.value?.includes?.('shop bot') || document.querySelector('.edbox textarea')?.value.includes('shop bot'));
  step('editor shows file content'); await S('4-editor');
  // تعديل وحفظ
  await pg.fill('.edbox textarea', 'import os, time, urllib.request\nBASE=os.environ["TELEGRAM_API_BASE"]; T=os.environ["BOT_TOKEN"]\nprint("shop bot online v2", flush=True)\nwhile True:\n    urllib.request.urlopen(f"{BASE}/bot{T}/getUpdates").read()\n');
  await pg.click('button:has-text("حفظ (Ctrl+S)")'); await pg.waitForSelector('.toast:has-text("تم الحفظ")'); step('edit+save ok');
  // نقل الملف
  pg.once('dialog', (d) => d.accept('app/shop.py'));
  await pg.hover('.tree .it:has-text("main.py")'); await pg.click('.tree .it:has-text("main.py") button[title^="نقل"]');
  await pg.waitForSelector('.tree .it:has-text("shop.py")'); await pg.waitForSelector('.main-b'); step('moved file, MAIN badge followed');
  // إعدادات: توكن خاطئ ثم صحيح
  await pg.click('.tabs a:has-text("الإعدادات")'); await pg.waitForSelector('input[type=password]');
  await pg.fill('input[type=password]', 'bad'); await pg.click('button:has-text("تحقق واحفظ")'); await pg.waitForSelector('.toast.bad'); step('bad token rejected in UI');
  await pg.fill('input[type=password]', GOOD); await pg.click('button:has-text("تحقق واحفظ")'); await pg.waitForSelector('.toast.good:has-text("التوكن")'); await S('5-settings'); step('good token saved');
  // تشغيل وفحص
  await pg.click('.tabs a:has-text("التحكم")'); await pg.waitForSelector('.console');
  await pg.click('button:has-text("تشغيل وفحص")');
  await pg.waitForSelector('.result.ok', { timeout: 30000 }); step('RUN OK shown');
  await pg.waitForSelector('.console .l:has-text("shop bot online v2")'); step('live log line appeared in console');
  await pg.waitForFunction(() => document.querySelector('.dot.running')); await pg.waitForTimeout(3500);
  const stat = await pg.$$eval('.stat b', (e) => e.map((x) => x.textContent)); console.log('   stats:', stat.join(' | '));
  await S('6-running');
  await pg.click('button:has-text("إيقاف")'); await pg.waitForSelector('.dot.stopped'); step('stopped -> indicator');
  // خطأ syntax في الواجهة
  await pg.click('.tabs a:has-text("الملفات")'); await pg.waitForSelector('.edbox textarea');
  await pg.fill('.edbox textarea', 'print("a"\nx=1\n'); await pg.click('button:has-text("حفظ (Ctrl+S)")'); await pg.waitForSelector('.toast:has-text("تم الحفظ")');
  await pg.click('.tabs a:has-text("التحكم")'); await pg.click('button:has-text("تشغيل وفحص")');
  await pg.waitForSelector('.result.bad'); const bad = await pg.textContent('.result.bad'); console.log('   error shown:', bad.replace(/\s+/g, ' ').slice(0, 160));
  await S('7-error');
  await pg.click('.result.bad a.mono'); await pg.waitForSelector('.edbox textarea'); step('click error -> jumped to editor');
  // AI
  await pg.goto('http://127.0.0.1:3100/#/app'); await pg.waitForSelector('.bot');
  await pg.click('button:has-text("أنشئ بوت بالذكاء الاصطناعي")'); await pg.fill('.mbox textarea', 'بوت أزرار فيه آلة حاسبة'); await pg.fill('.mbox input.mono', GOOD);
  await pg.click('.mbox button:has-text("ولّد وجرّب")'); await pg.waitForSelector('.console .l.step:has-text("اكتمل")', { timeout: 40000 }); step('AI flow completed in UI');
  await S('8-ai');
  // موبايل
  const mp = await br.newPage({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 }); await mp.goto('http://127.0.0.1:3100/'); await mp.waitForSelector('.hero'); await mp.screenshot({ path: '/tmp/bf-test/shots/9-mobile.png' });
  const ov = await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); console.log('   mobile horizontal overflow:', ov);
  console.log(errs.length ? 'JS ERRORS:\n' + errs.join('\n') : 'no JS errors');
  await br.close();
})().catch((e) => { console.error('UI TEST FAIL', e.message); process.exit(1); });
