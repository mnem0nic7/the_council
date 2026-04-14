FROM python:3.13-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY pyproject.toml /app/pyproject.toml
COPY app /app/app

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir . && \
    python -m playwright install --with-deps chromium

RUN mkdir -p /app/data/artifacts /app/data/workspaces

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
