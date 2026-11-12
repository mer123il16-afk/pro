# BotForge — منصة استضافة بوتات تيليجرام

استضافة بوتات Python/Node.js: رفع، فحص syntax حقيقي، تثبيت مكتبات تلقائي، تشغيل معزول، لوجات حية، محرر Monaco، ومولّد بوتات بالذكاء الاصطناعي مع تصحيح ذاتي.

## المعمارية

```
المتصفح (SPA عربية RTL) ──HTTPS──► Nginx ──► server.js (Node http، بدون Express)
                                              ├─ lib/auth.js    scrypt + JWT(HS256) + rate-limit
                                              ├─ lib/db.js      SQLite (node:sqlite) + تشفير AES-256-GCM للتوكنات
                                              ├─ lib/runner.js  طابور لكل بوت + فحص + تثبيت + تشغيل + CPU/RAM + SSE
                                              └─ lib/ai.js      OpenAI-compatible / Anthropic + حلقة التصحيح
                                              data/bots/<projectId>/  ← ملفات كل بوت (مجلد منفصل)
```

- **كل بوت = عملية منفصلة** (process group مستقل) أو **حاوية Docker** (`SANDBOX=docker`).
- **الطابور**: كل أوامر بوت واحد (run/start/stop/restart/delete) تُنفَّذ بالتتابع عبر promise-chain، فلا تعارض. التثبيتات محدودة بـ 2 بالتوازي.
- **الربط بمعرّف المشروع**: الملف الرئيسي ومجلد الإضافات يعيشان في `data/bots/<id>/`؛ المسار الرئيسي محفوظ في قاعدة البيانات ويتحدّث تلقائياً عند النقل/إعادة التسمية.
- **اللوجات الحية**: Server-Sent Events على `/api/bots/:id/stream`.
- **استعادة تلقائية**: البوتات التي كانت تعمل تُعاد عند إعادة تشغيل الخادم.

## هيكل المجلدات

```
botforge/
├─ server.js              الراوتر + الـ API + SSE + مهمة الذكاء الاصطناعي
├─ lib/
│  ├─ db.js  auth.js  runner.js  ai.js
├─ public/                الواجهة (Landing + Dashboard + Monaco)
│  ├─ index.html  css/style.css  js/app.js
├─ deploy/                botforge.service · nginx.conf
├─ test/                  e2e.js (55 اختبار API) · ui.js (Playwright) · mock-services.js
├─ .env.example  package.json
```

## المتطلبات (Dependencies)

| المكوّن | الإصدار | ملاحظة |
|---|---|---|
| Node.js | **22.5+** | فيه `node:sqlite` مدمج — **لا توجد حزم npm للمنصة نفسها** |
| Python 3 + pip | 3.10+ | لتشغيل بوتات بايثون وتثبيت مكتباتها |
| Nginx + certbot | أي حديث | بروكسي + HTTPS |
| Docker (اختياري) | 24+ | فقط إذا `SANDBOX=docker` |
| Monaco Editor | 0.52 | يُحمَّل في المتصفح من CDN (jsdelivr) |

## التشغيل محلياً

```bash
cp .env.example .env      # عدّل ما تحتاج
set -a; . ./.env; set +a
node --no-warnings server.js      # http://localhost:3000
```

## النشر على VPS (Ubuntu 22.04/24.04)

```bash
# 1) النظام
sudo apt update && sudo apt install -y nginx python3 python3-pip git curl ufw certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
node -v   # يجب >= 22.5

# 2) مستخدم مخصص + الكود
sudo useradd -r -m -s /usr/sbin/nologin botforge
sudo mkdir -p /opt/botforge && sudo cp -r ./* ./.env.example /opt/botforge/
cd /opt/botforge && sudo cp .env.example .env
sudo nano .env                      # اضبط AI_API_KEY و HOST=127.0.0.1
sudo chown -R botforge:botforge /opt/botforge && sudo chmod 600 /opt/botforge/.env

# 3) الخدمة
sudo cp deploy/botforge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now botforge
sudo systemctl status botforge      # + journalctl -u botforge -f

# 4) Nginx + HTTPS
sudo cp deploy/nginx.conf /etc/nginx/sites-available/botforge
sudo sed -i 's/YOUR_DOMAIN/example.com/' /etc/nginx/sites-available/botforge
sudo ln -s /etc/nginx/sites-available/botforge /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d example.com

# 5) الجدار الناري
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

### لعزل أقوى (موصى به إن كان المستخدمون غير موثوقين)
```bash
sudo apt install -y docker.io && sudo usermod -aG docker botforge
# في .env:  SANDBOX=docker   و   DOCKER_PY_IMAGE=python:3.<نفس إصدار السيرفر>-slim
sudo systemctl restart botforge
```
كل بوت يعمل عندها بحاوية: `--memory 512m --cpus 0.5 --pids-limit 128 --cap-drop ALL`.

### النسخ الاحتياطي
انسخ `data/` كاملاً (قاعدة البيانات + `secret.key` + ملفات البوتات). **فقدان `secret.key` = فقدان القدرة على فك تشفير التوكنات.**

## الذكاء الاصطناعي
اضبط في `.env`: `AI_API_KEY` (وعند الحاجة `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`). يعمل مع أي خدمة متوافقة مع OpenAI (OpenRouter، Ollama محلياً، vLLM...) أو Anthropic.
الحلقة: توليد → حفظ → فحص syntax → تثبيت مكتبات → تشغيل تجريبي (إن أُدخل توكن) → عند الخطأ يُرسَل نصه للنموذج ويُطبَّق الإصلاح، حتى `AI_MAX_FIXES` مرات.

## ملاحظات أمنية صريحة
- وضع `process` **ليس sandbox حقيقياً**: يفصل العمليات ويحدّ الذاكرة ويمنح البيئة نظيفة، لكن البوت يعمل بنفس مستخدم النظام ويستطيع الوصول للشبكة وقراءة ملفات يملك المستخدم صلاحيتها. للمستخدمين الغرباء استعمل `SANDBOX=docker`.
- التوكنات مشفّرة في القاعدة ومحجوبة من اللوجات، ولا تُرسل للواجهة أبداً.
