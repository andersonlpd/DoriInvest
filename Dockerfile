FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY run.py ./
COPY src ./src
COPY frontend ./frontend
COPY tools ./tools
COPY package.json ./

EXPOSE 8000
VOLUME ["/app/data"]

CMD ["python3", "run.py", "--port", "8000"]
