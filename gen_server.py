#!/usr/bin/env python3
"""مولّد الصور والفيديو الخاص بك - يعمل على جهازك أنت، بنماذج مفتوحة المصدر، بدون أي خدمة أو مفتاح خارجي.
يحتاج جهازًا فيه كرت شاشة NVIDIA (الصور: 8GB+، الفيديو: 12GB+ يفضّل 16GB). الجوال لا يكفي.

التثبيت (مرة واحدة):
  pip install torch diffusers transformers accelerate safetensors sentencepiece imageio imageio-ffmpeg pillow
التشغيل:
  export GEN_TOKEN="سر-طويل-تختاره-أنت"     # إجباري، نفس الرمز تضعه في ساحة التدريب
  python gen_server.py
اختياري:
  IMAGE_MODEL=stabilityai/stable-diffusion-xl-base-1.0   (بدّله بنموذج واقعي تفضّله)
  VIDEO_MODEL=Lightricks/LTX-Video
  LOW_VRAM=1   (يخفّف استهلاك الذاكرة ويبطّئ)
  GEN_HOST=0.0.0.0  GEN_PORT=8780
أول تشغيل ينزّل النماذج (عدة GB). النماذج تُحمَّل عند أول طلب.
"""
import base64, io, json, os, re, secrets, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("GEN_HOST", "0.0.0.0")
PORT = int(os.environ.get("GEN_PORT", "8780"))
TOKEN = os.environ.get("GEN_TOKEN", "").strip()
IMAGE_MODEL = os.environ.get("IMAGE_MODEL", "stabilityai/stable-diffusion-xl-base-1.0")
VIDEO_MODEL = os.environ.get("VIDEO_MODEL", "Lightricks/LTX-Video")
LOW_VRAM = os.environ.get("LOW_VRAM") == "1"
LOCK = threading.Lock()
_pipes = {}
NEG_IMG = "cartoon, painting, illustration, low quality, blurry, deformed, extra fingers, watermark, text"
NEG_VID = "worst quality, inconsistent motion, blurry, jittery, distorted"
_MIN = r"(child|children|kid|minor|underage|teen|schoolgirl|schoolboy|loli|طفل|أطفال|اطفال|قاصر)"
_SEX = r"(nude|naked|sex|porn|erotic|عاري|عارية|جنس|اباح|إباح)"
BLOCK = re.compile(_MIN + r".{0,40}" + _SEX + "|" + _SEX + r".{0,40}" + _MIN, re.I | re.S)


def load(name, model):
    if name not in _pipes:
        import torch
        from diffusers import DiffusionPipeline
        dt = torch.bfloat16 if name == "video" else torch.float16
        try:
            p = DiffusionPipeline.from_pretrained(model, torch_dtype=dt, use_safetensors=True)
        except Exception:
            p = DiffusionPipeline.from_pretrained(model, torch_dtype=dt)
        if LOW_VRAM:
            p.enable_model_cpu_offload()
        else:
            p.to("cuda")
        _pipes[name] = p
    return _pipes[name]


def gen_image(prompt, w, h):
    w, h = max(256, min(w, 1536)) // 8 * 8, max(256, min(h, 1536)) // 8 * 8
    img = load("image", IMAGE_MODEL)(prompt=prompt, negative_prompt=NEG_IMG, width=w, height=h,
                                      num_inference_steps=30, guidance_scale=6.0).images[0]
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode(), "image/png"


def gen_video(prompt, seconds):
    from diffusers.utils import export_to_video
    frames = max(9, min(int(seconds * 24), 161))
    frames = (frames - 1) // 8 * 8 + 1
    out = load("video", VIDEO_MODEL)(prompt=prompt, negative_prompt=NEG_VID, width=704, height=480,
                                      num_frames=frames, num_inference_steps=50).frames[0]
    path = tempfile.mktemp(suffix=".mp4")
    export_to_video(out, path, fps=24)
    try:
        return base64.b64encode(open(path, "rb").read()).decode(), "video/mp4"
    finally:
        os.remove(path)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        d = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(d)))
        self.end_headers()
        self.wfile.write(d)

    def do_GET(self):
        self.send(200, {"ok": True}) if self.path == "/health" else self.send(404, {"error": "غير موجود"})

    def do_POST(self):
        if not secrets.compare_digest(self.headers.get("X-Gen-Token", ""), TOKEN):
            return self.send(401, {"error": "رمز غير صحيح"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            b = json.loads(self.rfile.read(min(n, 100_000)) or b"{}")
            prompt = str(b.get("prompt", "")).strip()[:800]
            if len(prompt) < 3 or BLOCK.search(prompt):
                return self.send(400, {"error": "طلب غير مقبول"})
            with LOCK:
                if self.path == "/image":
                    data, mime = gen_image(prompt, int(b.get("width", 1024)), int(b.get("height", 1024)))
                elif self.path == "/video":
                    data, mime = gen_video(prompt, float(b.get("seconds", 4)))
                else:
                    return self.send(404, {"error": "غير موجود"})
            self.send(200, {"b64_json": data, "mime": mime})
        except Exception as e:
            self.send(500, {"error": f"فشل التوليد: {e}"})


if __name__ == "__main__":
    if len(TOKEN) < 12:
        raise SystemExit("اضبط GEN_TOKEN (12 حرفًا على الأقل) قبل التشغيل، مثال: export GEN_TOKEN=\"سر-طويل\"")
    print(f"مولّدك يعمل على http://{HOST}:{PORT}  (ضع هذا العنوان ورمزك في ساحة التدريب)")
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
