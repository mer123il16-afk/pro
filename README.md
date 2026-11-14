# المساعد

ملف واحد `assistant.py` يجمع الخادم والواجهة والذكاء الاصطناعي ومولّد الصور والفيديو والصوت.

## Termux
    pkg install python
    export ANTHROPIC_API_KEY=...        # أو AI_API_KEY و AI_BASE_URL
    python assistant.py
ثم افتح http://127.0.0.1:8765

## الصور والفيديو والصوت (جهاز فيه كرت NVIDIA)
    pip install torch diffusers transformers accelerate safetensors sentencepiece imageio imageio-ffmpeg pillow coqui-tts
    python assistant.py --gen
يطبع رمزًا: ضعه مع عنوان الجهاز في إعدادات المساعد (ساحة التدريب).

## استضافة (Render)
New ← Blueprint ← اختر المستودع. انسخ `ASSISTANT_TOKEN` من Environment وألصقه في إعدادات الواجهة، وأضف مفتاح النموذج في Environment.
الاستضافة المجانية تمسح المفاتيح والتدريب عند كل إعادة نشر.
