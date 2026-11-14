#!/usr/bin/env python3
"""الخادم المحلي للمساعد - يعمل داخل Termux (مكتبة بايثون القياسية فقط).
- يستمع على 127.0.0.1 فقط. للوضع البعيد ضع أمامه وكيل HTTPS واضبط ASSISTANT_PUBLIC_HOST.
- يمرّر طلبات النموذج إلى المزوّد؛ المفتاح يبقى في متغيرات البيئة ولا يصل للواجهة.
- ينفّذ أوامر Termux فقط إذا: (1) رمز الاقتران صحيح، (2) الأمر ضمن القائمة المسموحة،
  (3) الواجهة أرسلت موافقة المستخدم الصريحة. لا يستخدم shell، فلا أنابيب ولا ; ولا >.
"""
import hashlib, time, json, os, secrets, shlex, subprocess, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ALLOW_FILE = HERE / "allowed.json"
PORT = int(os.environ.get("ASSISTANT_PORT", "8765"))
HOST = os.environ.get("ASSISTANT_HOST", "127.0.0.1")
LOCAL = HOST in ("127.0.0.1", "localhost")
PUBLIC_HOST = os.environ.get("ASSISTANT_PUBLIC_HOST", "")  # نطاقك خلف وكيل HTTPS
KEYS_FILE = HERE / "keys.json"
CFG_FILE = HERE / "config.json"
VOICES = HERE / "voices"
TOKEN_FILE = Path.home() / ".assistant_token"
PAIRED = False


def load_token():
    t = (os.environ.get("ASSISTANT_TOKEN") or "").strip()
    if not t:
        try:
            t = TOKEN_FILE.read_text().strip()
        except Exception:
            t = ""
    return t, bool(t)


TOKEN, USER_SET = load_token()
if not TOKEN:
    TOKEN = secrets.token_urlsafe(12)
DEFAULT_ALLOWED = ["ls", "pwd", "whoami", "date", "uname", "df", "free", "uptime",
                   "ping", "ip", "termux-battery-status", "termux-wifi-connectioninfo"]
# أوامر حساسة: إن أضافها المالك للقائمة تتطلب تأكيدًا إضافيًا في كل مرة
DANGER = {"rm", "dd", "mkfs", "shutdown", "reboot", "chmod", "chown", "kill", "pkill",
          "su", "sudo", "mv", "pkg", "apt", "pip", "termux-setup-storage", "termux-reload-settings"}
MAX_OUT = 8000


class Err(Exception):
    def __init__(self, code, msg):
        self.code, self.msg = code, msg


def keys_load():
    try:
        return json.loads(KEYS_FILE.read_text())
    except Exception:
        return {}


def keys_save(d):
    KEYS_FILE.write_text(json.dumps(d, ensure_ascii=False))
    try:
        os.chmod(KEYS_FILE, 0o600)
    except Exception:
        pass


def cfg_load():
    try:
        return json.loads(CFG_FILE.read_text())
    except Exception:
        return {}


def allowed():
    try:
        return [str(x) for x in json.loads(ALLOW_FILE.read_text())]
    except Exception:
        return list(DEFAULT_ALLOWED)


def post_json(url, headers, body, timeout=180):
    req = urllib.request.Request(url, json.dumps(body).encode(), headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        raise Err(502, f"رفض المزوّد الطلب ({e.code}): {detail}")
    except Exception as e:
        raise Err(502, f"تعذّر الوصول إلى المزوّد: {e}")


def pick_model():
    m = os.environ.get("LOCAL_MODEL")
    if m:
        return m
    try:
        gb = int(open("/proc/meminfo").readline().split()[1]) / 1048576
    except Exception:
        gb = 4
    return "qwen2.5:7b" if gb >= 12 else "qwen2.5:3b" if gb >= 5 else "qwen2.5:1.5b"


OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")


def local_up():
    try:
        urllib.request.urlopen(OLLAMA + "/api/tags", timeout=1).read()
        return True
    except Exception:
        return False


import heapq
import base64
import re as _re
import urllib.parse

KB_FILE = HERE / "kb.jsonl"  # سطر لكل مقطع نصي؛ يُقرأ تدفقيًا فلا يثقل الذاكرة
KB_MAX = 50 * 1024 * 1024


def _words(t):
    return {(w[2:] if w.startswith("ال") else w) for w in _re.split(r"[\s.,،؛:!؟?()\"«»\n]+", t) if len(w) > 2}


def kb_add(text):
    if KB_FILE.exists() and KB_FILE.stat().st_size > KB_MAX:
        raise Err(413, "قاعدة المعرفة ممتلئة (50MB). امسحها أو قلّل البيانات.")
    n = 0
    with KB_FILE.open("a", encoding="utf-8") as f:
        for para in _re.split(r"\n\s*\n", text):
            para = para.strip()
            for i in range(0, len(para), 600):
                c = para[i:i + 600].replace("\n", " ")
                if len(c) > 3:
                    f.write(c + "\n")
                    n += 1
    return n


def kb_stats():
    if not KB_FILE.exists():
        return {"chunks": 0, "mb": 0}
    with KB_FILE.open(encoding="utf-8", errors="ignore") as f:
        n = sum(1 for _ in f)
    return {"chunks": n, "mb": round(KB_FILE.stat().st_size / 1048576, 1)}


def kb_search(messages):
    if not KB_FILE.exists():
        return ""
    q = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
    qw = _words(str(q))
    if not qw:
        return ""

    def gen():
        with KB_FILE.open(encoding="utf-8", errors="ignore") as f:
            for line in f:
                sc = len(qw & _words(line))
                if sc:
                    yield sc, line.strip()
    top = heapq.nlargest(5, gen(), key=lambda x: x[0])
    return ("\nمن بيانات تدريب المالك (استعملها إن ارتبطت بالسؤال):\n- " + "\n- ".join(t for _, t in top)) if top else ""


def http_get(url, headers=None, limit=2_000_000):
    req = urllib.request.Request(url, headers=dict({"User-Agent": "assistant"}, **(headers or {})))
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read(limit).decode("utf-8", "ignore")


_MIN = r"(child|children|kid|minor|underage|teen|schoolgirl|schoolboy|loli|طفل|أطفال|اطفال|قاصر)"
_SEX = r"(nude|naked|sex|porn|erotic|عاري|عارية|جنس|اباح|إباح)"
BLOCK = _re.compile(_MIN + r".{0,40}" + _SEX + "|" + _SEX + r".{0,40}" + _MIN, _re.I | _re.S)


def gen_cfg():
    c = cfg_load()
    return (os.environ.get("GEN_URL") or c.get("gen_url", "")).rstrip("/"), (os.environ.get("GEN_TOKEN") or c.get("gen_token", ""))


def gen_voice_req(b):
    url, tok = gen_cfg()
    if not url:
        raise Err(503, "لم يُضبط مولّدك الخاص. ضع عنوانه ورمزه في الإعدادات.")
    text = str(b.get("input") or b.get("text") or "").strip()[:1500]
    if not text:
        raise Err(400, "النص مطلوب")
    voice = str(b.get("voice", "female"))
    f = VOICES / (_re.sub(r"[^A-Za-z0-9_-]", "", voice) + ".wav")
    ref = base64.b64encode(f.read_bytes()).decode() if voice not in ("female", "male") and f.exists() else None
    try:
        j = post_json(url + "/voice", {"content-type": "application/json", "X-Gen-Token": tok},
                      {"prompt": text, "speaker": voice, "language": str(b.get("language", "ar"))[:5], "ref_b64": ref}, 900)
        return {"created": int(time.time()), "data": [{"b64_json": j["b64_json"], "mime": "audio/wav"}]}
    except KeyError:
        raise Err(502, "ردّ المولّد غير مفهوم.")


def gen_media(kind, b):
    if kind == "voice":
        return gen_voice_req(b)
    prompt = str(b.get("prompt", "")).strip()[:600]
    if len(prompt) < 3:
        raise Err(400, "الوصف (prompt) مطلوب")
    if BLOCK.search(prompt):
        raise Err(400, "هذا الطلب مرفوض.")
    url, tok = gen_cfg()
    if not url:
        raise Err(503, "لم يُضبط مولّدك الخاص. شغّل gen_server.py على جهاز فيه كرت NVIDIA وضع عنوانه ورمزه في ساحة التدريب.")
    en = prompt
    if _re.search(r"[^\x00-\x7f]", prompt):
        try:
            en = call_model("anthropic", os.environ.get("TRANSLATE_MODEL", "claude-sonnet-5-5"),
                            "حوّل وصف المستخدم إلى برومبت إنجليزي مفصّل لتوليد صورة أو فيديو في سطر واحد فقط بلا شرح ولا علامات.",
                            [{"role": "user", "content": prompt}], kb=False).strip()[:600] or prompt
        except Exception:
            en = prompt
    if BLOCK.search(en):
        raise Err(400, "هذا الطلب مرفوض.")
    hd = {"content-type": "application/json", "X-Gen-Token": tok}
    try:
        if kind == "images":
            try:
                w, h = [int(x) for x in str(b.get("size", "1024x1024")).split("x")]
            except Exception:
                w, h = 1024, 1024
            q = en if _re.search(r"photo|realistic", en, _re.I) else en + ", photorealistic, highly detailed, natural lighting"
            j = post_json(url + "/image", hd, {"prompt": q, "width": w, "height": h}, 900)
            item = {"b64_json": j["b64_json"], "revised_prompt": en}
        else:
            try:
                secs = max(2, min(int(b.get("seconds", 4)), 6))
            except Exception:
                secs = 4
            j = post_json(url + "/video", hd, {"prompt": en, "seconds": secs}, 1800)
            item = {"b64_json": j["b64_json"], "revised_prompt": en, "mime": "video/mp4"}
    except KeyError:
        raise Err(502, "ردّ المولّد غير مفهوم.")
    return {"created": int(time.time()), "data": [item]}


def kb_fetch(url, rows=500):
    gh, hf = os.environ.get("GITHUB_TOKEN"), os.environ.get("HF_TOKEN")
    total = 0
    m = _re.match(r"https://github\.com/([^/]+)/([^/#?]+)", url)
    if m:
        o, r = m.group(1), m.group(2)
        r = r[:-4] if r.endswith(".git") else r
        h = {"Authorization": "Bearer " + gh} if gh else {}
        tree = json.loads(http_get(f"https://api.github.com/repos/{o}/{r}/git/trees/HEAD?recursive=1", h, 5_000_000))
        ext = (".md", ".txt", ".py", ".js", ".ts", ".json", ".html", ".css", ".gd", ".java", ".kt", ".c", ".cpp", ".rs", ".go", ".sh", ".yml", ".yaml", ".csv")
        files = [t["path"] for t in tree.get("tree", []) if t.get("type") == "blob" and t["path"].lower().endswith(ext) and t.get("size", 0) < 300_000][:200]
        for pth in files:
            try:
                txt = http_get(f"https://raw.githubusercontent.com/{o}/{r}/HEAD/{urllib.parse.quote(pth)}", h, 300_000)
            except Exception:
                continue
            total += kb_add(f"[{o}/{r}/{pth}]\n" + txt)
            time.sleep(0.05)
        return total
    m = _re.match(r"https://huggingface\.co/datasets/([^/]+/[^/#?]+)", url)
    if m:
        ds = m.group(1)
        h = {"Authorization": "Bearer " + hf} if hf else {}
        sp = json.loads(http_get("https://datasets-server.huggingface.co/splits?dataset=" + ds, h))["splits"][0]
        for off in range(0, min(int(rows), 5000), 100):
            d = json.loads(http_get("https://datasets-server.huggingface.co/rows?dataset=" + ds + "&config=" + urllib.parse.quote(sp["config"]) + "&split=" + urllib.parse.quote(sp["split"]) + f"&offset={off}&length=100", h, 3_000_000))
            got = d.get("rows", [])
            if not got:
                break
            for rw in got:
                total += kb_add(" | ".join(f"{k}: {v}" for k, v in rw["row"].items()))
        return total
    return kb_add(url + "\n" + http_get(url, {}, 2_000_000))


def call_model(provider, model, system, messages, kb=True):
    if kb:
        system = system + kb_search(messages)
    hf = os.environ.get("HF_TOKEN")
    if hf and not os.environ.get("ANTHROPIC_API_KEY"):
        d = post_json(os.environ.get("HF_BASE", "https://router.huggingface.co/v1") + "/chat/completions",
                      {"authorization": "Bearer " + hf, "content-type": "application/json"},
                      {"model": os.environ.get("HF_MODEL", "openai/gpt-oss-120b:fastest"), "max_tokens": 4000,
                       "messages": [{"role": "system", "content": system}] + messages})
        return d["choices"][0]["message"]["content"]
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("AI_API_KEY")):
        if not local_up():
            raise Err(503, "لا يوجد نموذج محلي شغّال. في جلسة Termux ثانية شغّل: ollama serve")
        d = post_json(OLLAMA + "/api/chat", {"content-type": "application/json"},
                      {"model": pick_model(), "stream": False,
                       "messages": [{"role": "system", "content": system}] + messages})
        return d.get("message", {}).get("content", "")
    if provider == "anthropic":
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise Err(503, "المتغير ANTHROPIC_API_KEY غير مضبوط في Termux.")
        d = post_json("https://api.anthropic.com/v1/messages",
                      {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                      {"model": model, "max_tokens": 8000, "system": system, "messages": messages})
        return "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text")
    key, base = os.environ.get("AI_API_KEY"), os.environ.get("AI_BASE_URL", "").rstrip("/")
    if not key or not base:
        raise Err(503, "اضبط AI_API_KEY و AI_BASE_URL لمزوّد متوافق مع OpenAI.")
    d = post_json(base + "/chat/completions",
                  {"authorization": "Bearer " + key, "content-type": "application/json"},
                  {"model": model, "max_tokens": 8000,
                   "messages": [{"role": "system", "content": system}] + messages})
    return d["choices"][0]["message"]["content"]


def run_command(cmd, danger_ok):
    try:
        argv = shlex.split(cmd)
    except ValueError:
        raise Err(400, "صيغة الأمر غير صالحة.")
    if not argv:
        raise Err(400, "الأمر فارغ.")
    if argv[0] not in allowed():
        raise Err(403, f"الأمر «{argv[0]}» خارج القائمة المسموحة. يضيفه المالك من الإعدادات إن أراد.")
    if (argv[0] in DANGER or any(a in ("-rf", "-fr", "-R") for a in argv)) and not danger_ok:
        raise Err(409, "أمر حساس: يلزم تأكيد إضافي.")
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=20, cwd=str(Path.home()))
    except subprocess.TimeoutExpired:
        raise Err(504, "انتهت مهلة التنفيذ (20 ثانية).")
    except FileNotFoundError:
        raise Err(404, f"الأمر «{argv[0]}» غير مثبّت.")
    return {"code": p.returncode, "out": (p.stdout + p.stderr)[:MAX_OUT]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Token, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send(204, b"", "text/plain")

    def host_ok(self):
        h = self.headers.get("Host", "")
        return h in (f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"[::1]:{PORT}") or (PUBLIC_HOST != "" and (PUBLIC_HOST == "*" or h == PUBLIC_HOST))

    def authed(self):
        if self.path != "/api/exec" and self.host_ok() and not PUBLIC_HOST:
            return True
        return secrets.compare_digest(self.headers.get("X-Token", ""), TOKEN)

    def key_ok(self):
        k = self.headers.get("Authorization", "")[7:].strip()
        h = hashlib.sha256(k.encode()).hexdigest()
        return bool(k) and any(secrets.compare_digest(v["hash"], h) for v in keys_load().values())

    def api_v1(self):
        try:
            k = self.headers.get("Authorization", "")[7:].strip()
            h = hashlib.sha256(k.encode()).hexdigest()
            if not k or not any(secrets.compare_digest(v["hash"], h) for v in keys_load().values()):
                return self.send(401, {"error": {"message": "مفتاح غير صالح"}})
            n = int(self.headers.get("Content-Length", "0"))
            b = json.loads(self.rfile.read(min(n, 3_000_000)) or b"{}")
            ms = b.get("messages", [])
            sysm = "\n".join(str(m.get("content", "")) for m in ms if m.get("role") == "system")[:8000]
            rest = [m for m in ms if m.get("role") in ("user", "assistant")][-30:]
            try:
                brain = (HERE / "brain.txt").read_text(encoding="utf-8")[-30000:]
                sysm = ("ما تعلّمته عن المالك:\n" + brain + "\n" + sysm)[:40000]
            except Exception:
                pass
            text = call_model("anthropic", b.get("model", ""), sysm, rest)
            text = _re.sub(r"```remember[\s\S]*?```", "", text).strip() or "تم."
            return self.send(200, {"object": "chat.completion", "model": b.get("model", "local"),
                                   "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]})
        except Err as e:
            self.send(e.code, {"error": {"message": e.msg}})
        except Exception as e:
            self.send(500, {"error": {"message": str(e)}})

    def api_media(self):
        try:
            if not self.key_ok():
                return self.send(401, {"error": {"message": "مفتاح غير صالح"}})
            n = int(self.headers.get("Content-Length", "0"))
            b = json.loads(self.rfile.read(min(n, 200_000)) or b"{}")
            if self.path.endswith("/audio/speech"):
                raw = base64.b64decode(gen_media("voice", b)["data"][0]["b64_json"])
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                return self.wfile.write(raw)
            kind = "images" if self.path.endswith("/images/generations") else "videos"
            return self.send(200, gen_media(kind, b))
        except Err as e:
            self.send(e.code, {"error": {"message": e.msg}})
        except Exception as e:
            self.send(500, {"error": {"message": str(e)}})

    def api_voice(self):
        try:
            if not self.authed():
                return self.send(401, {"error": "غير مصرح"})
            n = int(self.headers.get("Content-Length", "0"))
            b = json.loads(self.rfile.read(min(n, 16_000_000)) or b"{}")
            VOICES.mkdir(exist_ok=True)
            if self.path == "/api/voices":
                return self.send(200, {"voices": sorted(p.stem for p in VOICES.glob("*.wav"))})
            name = _re.sub(r"[^A-Za-z0-9_-]", "", str(b.get("name", "")))[:30] or "voice"
            raw = base64.b64decode(str(b.get("b64", "")).split(",")[-1])
            if not 2000 < len(raw) < 12_000_000:
                raise Err(400, "مقطع غير صالح")
            (VOICES / (name + ".wav")).write_bytes(raw)
            return self.send(200, {"ok": True, "name": name})
        except Err as e:
            self.send(e.code, {"error": e.msg})
        except Exception as e:
            self.send(500, {"error": str(e)})

    def do_GET(self):
        if self.path in ("/v1/models", "/models"):
            if not self.key_ok():
                return self.send(401, {"error": {"message": "مفتاح غير صالح"}})
            return self.send(200, {"object": "list", "data": [{"id": "local", "object": "model"}]})
        if not self.host_ok():
            return self.send(403, {"error": "مضيف غير مسموح"})
        if self.path in ("/", "/index.html"):
            f = next((p for p in (HERE / "index.html", HERE / "assistant.html") if p.exists()), HERE / "index.html")
            if not f.exists():
                return self.send(200, "الخادم يعمل. افتح ملف HTML واربطه بهذا العنوان.".encode(), "text/plain; charset=utf-8")
            return self.send(200, f.read_bytes(), "text/html; charset=utf-8")
        if self.path == "/api/status":
            has = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("AI_API_KEY") or os.environ.get("HF_TOKEN") or local_up())
            return self.send(200, {"ok": True, "has_key": has})
        if self.path == "/api/check":
            if not self.authed():
                return self.send(401, {"error": "رمز الاقتران غير صحيح"})
            return self.send(200, {"ok": True, "valid": True})
        if self.path == "/api/kb/stats":
            if not self.authed():
                return self.send(401, {"error": "غير مصرّح"})
            return self.send(200, kb_stats())
        if self.path == "/api/keys":
            if not self.authed():
                return self.send(401, {"error": "رمز الاقتران غير صحيح"})
            return self.send(200, {"keys": [{"id": i, "name": v["name"], "created": v["created"]} for i, v in keys_load().items()]})
        if self.path == "/api/allowlist":
            if not self.authed():
                return self.send(401, {"error": "رمز الاقتران غير صحيح"})
            return self.send(200, {"allowed": allowed()})
        self.send(404, {"error": "غير موجود"})

    def do_POST(self):
        if self.path in ("/v1/chat/completions", "/chat/completions"):
            return self.api_v1()
        if self.path in ("/v1/images/generations", "/v1/videos/generations", "/v1/audio/speech"):
            return self.api_media()
        if self.path in ("/api/voice/upload", "/api/voices"):
            return self.api_voice()
        if not self.host_ok():
            return self.send(403, {"error": "مضيف غير مسموح"})
        if not self.authed():
            return self.send(401, {"error": "رمز الاقتران غير صحيح"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            b = json.loads(self.rfile.read(min(n, 200_000)) or b"{}")
            if self.path == "/api/config":
                gu = str(b.get("gen_url", "")).strip().rstrip("/")[:300]
                if gu and not gu.startswith(("http://", "https://")):
                    raise Err(400, "عنوان المولّد لازم يبدأ بـ http:// أو https://")
                c = cfg_load()
                c["gen_url"] = gu
                c["gen_token"] = str(b.get("gen_token", "")).strip()[:200]
                CFG_FILE.write_text(json.dumps(c, ensure_ascii=False))
                try:
                    os.chmod(CFG_FILE, 0o600)
                except Exception:
                    pass
                return self.send(200, {"ok": True})
            if self.path == "/api/gen":
                return self.send(200, gen_media({"images": "images", "voice": "voice"}.get(b.get("kind"), "videos"), b))
            if self.path == "/api/brain":
                (HERE / "brain.txt").write_text(str(b.get("text", ""))[:40000], encoding="utf-8")
                return self.send(200, {"ok": True})
            if self.path == "/api/kb/add":
                return self.send(200, {"added": kb_add(str(b.get("text", ""))[:2_000_000])})
            if self.path == "/api/kb/fetch":
                u = str(b.get("url", "")).strip()
                if not u.startswith("https://"):
                    raise Err(400, "الرابط لازم يبدأ بـ https://")
                try:
                    return self.send(200, {"added": kb_fetch(u, b.get("rows", 500))})
                except Err:
                    raise
                except Exception as e:
                    raise Err(502, f"تعذّر الجلب: {e}")
            if self.path == "/api/kb/clear":
                KB_FILE.unlink(missing_ok=True)
                return self.send(200, {"ok": True})
            if self.path == "/api/keys/create":
                d, kid = keys_load(), secrets.token_hex(4)
                key = os.environ.get("ASSISTANT_KEY_PREFIX", "mh-") + secrets.token_urlsafe(24)
                name = str(b.get("name", "مفتاحي"))[:40] or "مفتاحي"
                d[kid] = {"name": name, "hash": hashlib.sha256(key.encode()).hexdigest(), "created": time.strftime("%Y-%m-%d")}
                keys_save(d)
                return self.send(200, {"key": key, "id": kid, "name": name})
            if self.path == "/api/keys/revoke":
                d = keys_load()
                d.pop(str(b.get("id", "")), None)
                keys_save(d)
                return self.send(200, {"ok": True})
            if self.path == "/api/pair":
                global PAIRED
                if not PAIRED:
                    PAIRED = True
                    print("\n✅ تم الربط بنجاح")
                return self.send(200, {"paired": True})
            if self.path == "/api/chat":
                text = call_model(b.get("provider", "anthropic"), b.get("model", ""),
                                  str(b.get("system", ""))[:40000], b.get("messages", [])[-30:])
                return self.send(200, {"text": text})
            if self.path == "/api/exec":
                if b.get("approved") is not True:
                    raise Err(403, "لا تنفيذ دون موافقة صريحة.")
                return self.send(200, run_command(str(b.get("command", "")), b.get("danger_ok") is True))
            if self.path == "/api/allowlist":
                lst = sorted({str(x).strip() for x in b.get("allowed", []) if str(x).strip() and " " not in str(x)})
                ALLOW_FILE.write_text(json.dumps(lst, ensure_ascii=False))
                return self.send(200, {"allowed": lst})
            self.send(404, {"error": "غير موجود"})
        except Err as e:
            self.send(e.code, {"error": e.msg})
        except Exception as e:
            self.send(500, {"error": f"خطأ داخلي: {e}"})


def ensure_local():
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("AI_API_KEY") or os.environ.get("HF_TOKEN"):
        return
    import shutil
    if not shutil.which("ollama"):
        print("لتشغيل النموذج المجاني ثبّت مرة واحدة:  pkg install ollama")
        return
    if not local_up():
        subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(20):
            time.sleep(1)
            if local_up():
                break
    model = pick_model()
    try:
        have = model in urllib.request.urlopen(OLLAMA + "/api/tags", timeout=3).read().decode()
    except Exception:
        have = False
    if not have:
        print(f"جاري تحميل النموذج {model} (مرة واحدة فقط)...")
        subprocess.run(["ollama", "pull", model])
    print("✅ النموذج المجاني جاهز")


def start_tunnel():
    import re, threading
    try:
        p = subprocess.Popen(["cloudflared", "tunnel", "--url", f"http://{HOST}:{PORT}"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    except FileNotFoundError:
        print("cloudflared غير مثبت. ثبّته: pkg install cloudflared")
        return

    def rd():
        for line in p.stderr:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m:
                print(f"\n🌍 عنوانك العام (Base URL):  {m.group(0)}/v1\n   المفتاح: مفتاحك mh-...\n")
    threading.Thread(target=rd, daemon=True).start()


if __name__ == "__main__":
    if not LOCAL and os.environ.get("ASSISTANT_BEHIND_HTTPS") != "1":
        raise SystemExit("رفض التشغيل: الربط على عنوان عام دون HTTPS غير آمن. استخدم وكيل HTTPS على 127.0.0.1.")
    print(f"\nالمساعد يعمل. افتح هذا العنوان في المتصفح:  http://{HOST}:{PORT}")
    if USER_SET:
        print("رمز الاقتران محفوظ (سرّي، لا يُعرض). بانتظار الربط من التطبيق...\n")
    else:
        print(f"(اختياري، لأوامر Termux فقط) الرمز:  {TOKEN}\n")
    ensure_local()
    if os.environ.get("ASSISTANT_TUNNEL") == "1":
        start_tunnel()
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
