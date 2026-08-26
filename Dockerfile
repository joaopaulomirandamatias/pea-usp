FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    APP_HOST=0.0.0.0 \
    PORT=8080 \
    PEA_DATA_DIR=/data

COPY . .

RUN mkdir -p /data

EXPOSE 8080

CMD ["python3", "server.py"]
