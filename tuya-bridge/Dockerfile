FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bridge.py decode.py ./

RUN useradd --create-home --uid 10001 bridge \
    && mkdir -p /data \
    && chown -R bridge:bridge /data /app
USER bridge

CMD ["python", "-u", "bridge.py"]
