FROM python:3.12-slim
WORKDIR /app
COPY assistant.html assistant_server.py ./
ENV ASSISTANT_HOST=0.0.0.0 ASSISTANT_PUBLIC_HOST=* PYTHONUNBUFFERED=1
CMD ["sh", "-c", "ASSISTANT_PORT=${PORT:-8765} python assistant_server.py"]
