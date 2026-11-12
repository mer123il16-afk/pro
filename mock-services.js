// خادم تيليجرام وهمي + نموذج ذكاء اصطناعي وهمي (لاختبار المنصة بدون إنترنت)
const http = require('http');
const GOOD = '123456789:AAFakeTokenForTestingOnly_abcdefghij';
let aiCalls = 0;
const tg = http.createServer((req, res) => {
  const m = req.url.match(/^\/bot([^/]+)\/(\w+)/);
  res.setHeader('content-type', 'application/json');
  if (!m || m[1] !== GOOD) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })); }
  if (m[2] === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 123456789, first_name: 'TestBot', username: 'test_bot' } }));
  if (m[2] === 'getUpdates') return setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 1500);
  res.end(JSON.stringify({ ok: true, result: true }));
}).listen(9101);
const BAD_PY = `=== FILE: main.py ===\nimport os\nprint("hi"\n=== FILE: requirements.txt ===\n`;
const GOOD_PY = `=== FILE: main.py ===
import os, json, time, urllib.request
BASE = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org")
TOKEN = os.environ["BOT_TOKEN"]
print("calculator bot started", flush=True)
while True:
    try:
        urllib.request.urlopen(f"{BASE}/bot{TOKEN}/getUpdates", timeout=10).read()
    except Exception as e:
        print("poll error", e, flush=True)
    time.sleep(1)
=== FILE: requirements.txt ===
`;
const ai = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    aiCalls++;
    const body = JSON.parse(b || '{}');
    const last = body.messages[body.messages.length - 1].content;
    const content = last.includes('failed with this error') ? GOOD_PY : BAD_PY; // أول مرة كود معطوب، ثم يصلحه
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(9102);
console.log('mocks up');
