FROM python:3.13-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends z3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV SUDOKU_HOST=0.0.0.0 \
    SUDOKU_PORT=8080 \
    SUDOKU_DEBUG=0 \
    SUDOKU_DB_PATH=/data/puzzles.db \
    PYTHONUNBUFFERED=1

EXPOSE 8080

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "--timeout", "60", "app:app"]
