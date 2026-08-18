#!/usr/bin/env python3
"""Tuya -> dashboard SHADOW power bridge.

Subscribes to Tuya Sharing-SDK MQTT pushes for one QS-WIFI-CT02 2-clamp meter
and forwards each phase reading to the dashboard as an ESP-shaped POST
({"v","i1","i2"}). This is a SHADOW feed: it targets /api/power/tuya-ingest,
which is deliberately isolated from the AC-leveling controller. It must never
touch the ESP /api/power/ingest path.

Env:
    TUYA_DEVICE_ID    (required)  device to forward; all others ignored
    TUYA_INGEST_TOKEN            bearer token for the shadow ingest route
    TARGET_URL                  default http://dashboard:8000/api/power/tuya-ingest
    TUYA_TOKEN_FILE             default /data/token_info.json
    PHASE_A_ROLE                i1 (default) or i2; phase_b takes the other slot
    WATCHDOG_S                  default 90; idle seconds before we re-subscribe
"""
import json
import os
import queue
import signal
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

import requests
from tuya_sharing import Manager
from tuya_sharing.customerapi import SharingTokenListener

from decode import decode_phase

DP_PHASE_A = 6
DP_PHASE_B = 7


# ---------- structured logging ----------

def log(level: str, msg: str, **fields: Any) -> None:
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level, "msg": msg}
    record.update(fields)
    print(json.dumps(record, default=str), flush=True)


# ---------- config ----------

@dataclass
class Config:
    device_id: str
    target_url: str
    ingest_token: str
    phase_a_role: str
    watchdog_s: float
    token_file: str


def load_config() -> Config:
    device_id = os.environ.get("TUYA_DEVICE_ID", "").strip()
    if not device_id:
        raise SystemExit("TUYA_DEVICE_ID is required")
    role = os.environ.get("PHASE_A_ROLE", "i1").strip().lower()
    if role not in ("i1", "i2"):
        raise SystemExit("PHASE_A_ROLE must be i1 or i2")
    return Config(
        device_id=device_id,
        target_url=os.environ.get("TARGET_URL", "http://dashboard:8000/api/power/tuya-ingest"),
        ingest_token=os.environ.get("TUYA_INGEST_TOKEN", ""),
        phase_a_role=role,
        watchdog_s=float(os.environ.get("WATCHDOG_S", "90")),
        token_file=os.environ.get("TUYA_TOKEN_FILE", "/data/token_info.json"),
    )


# ---------- token persistence ----------

class FileTokenListener(SharingTokenListener):
    """Persists refreshed tokens back into the token bundle file (atomic rewrite)."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.Lock()

    def update_token(self, token_info: dict) -> None:
        try:
            with self._lock:
                with open(self._path) as f:
                    bundle = json.load(f)
                bundle.update(token_info)
                tmp = self._path + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(bundle, f)
                os.replace(tmp, self._path)
            log("info", "token refreshed", keys=sorted(token_info.keys()))
        except Exception as e:
            log("error", "token persist failed", error=str(e))


# ---------- per-phase state ----------

class PhaseState:
    """Newest voltage plus the last-seen current for each i-slot.

    Returns None until BOTH phases have been observed at least once: forwarding
    earlier would fabricate a 0.0 reading for the unseen clamp, and the server
    flushes its very first POST straight into tuya_power_readings (Codex review
    finding, 2026-08-18). The device pushes both phases ~100ms apart, so the
    suppression lasts one push in practice.
    """

    def __init__(self, phase_a_role: str) -> None:
        self._a_slot = phase_a_role
        self._b_slot = "i2" if phase_a_role == "i1" else "i1"
        self._lock = threading.Lock()
        self._seen: set[str] = set()
        self.voltage = 0.0
        self.i1 = 0.0
        self.i2 = 0.0

    def update(self, dp_id: int, reading) -> Optional[dict]:
        slot = self._a_slot if dp_id == DP_PHASE_A else self._b_slot
        with self._lock:
            self.voltage = reading.voltage
            if slot == "i1":
                self.i1 = reading.current
            else:
                self.i2 = reading.current
            self._seen.add(slot)
            if len(self._seen) < 2:
                return None
            return {"v": self.voltage, "i1": self.i1, "i2": self.i2}


# ---------- bridge ----------

class Bridge:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.state = PhaseState(cfg.phase_a_role)
        self.session = requests.Session()
        self.headers = {"Authorization": f"Bearer {cfg.ingest_token}"} if cfg.ingest_token else {}
        self.stop_event = threading.Event()
        self.manager: Optional[Manager] = None
        self._last_push = time.monotonic()
        self.pushes = 0
        self.posts = 0
        self.post_errors = 0
        self.dropped = 0
        # POSTs happen on a worker thread, never on the MQTT listener thread — a
        # slow/down dashboard would otherwise block paho's network loop for up to
        # 5s per push and cascade into Tuya keepalive misses and disconnects
        # (Codex review finding, 2026-08-18). Bounded: on overflow we drop the
        # OLDEST payload (newest reading wins — this is a live feed).
        self._post_q: "queue.Queue[dict]" = queue.Queue(maxsize=32)

    # --- MQTT push handling ---

    def on_message(self, msg: dict) -> None:
        # Never let a bad push kill the listener thread.
        try:
            if not isinstance(msg, dict) or msg.get("protocol") != 4:
                return
            data = msg.get("data") or {}
            if data.get("devId") != self.cfg.device_id:
                return
            # Stamp AFTER the device filter: the watchdog must mean "OUR meter is
            # reporting", not "the MQTT pipe carries something" — account-level
            # chatter (bizCode events, other devices) may not pet it.
            self._last_push = time.monotonic()
            self.pushes += 1
            for dp in data.get("status") or []:
                dp_id = dp.get("dpId")
                if dp_id not in (DP_PHASE_A, DP_PHASE_B):
                    continue
                reading = decode_phase(dp["value"])
                payload = self.state.update(dp_id, reading)
                if payload is not None:
                    self._enqueue(payload)
        except Exception as e:
            log("error", "listener error", error=str(e))

    def _enqueue(self, payload: dict) -> None:
        """Hand a payload to the POST worker without ever blocking this thread."""
        while True:
            try:
                self._post_q.put_nowait(payload)
                return
            except queue.Full:
                try:
                    self._post_q.get_nowait()  # drop the OLDEST; newest reading wins
                    self.dropped += 1
                except queue.Empty:
                    pass

    def post_worker(self) -> None:
        """Drains the queue; blocks only itself, never the MQTT listener."""
        while not self.stop_event.is_set():
            try:
                payload = self._post_q.get(timeout=1.0)
            except queue.Empty:
                continue
            self._post(payload)

    def _post(self, payload: dict) -> None:
        try:
            resp = self.session.post(self.cfg.target_url, json=payload, headers=self.headers, timeout=5)
            self.posts += 1
            if resp.status_code >= 400:
                self.post_errors += 1
                log("warn", "ingest rejected", status=resp.status_code, body=resp.text[:200])
        except Exception as e:
            self.post_errors += 1
            log("error", "ingest post failed", error=str(e))

    # --- subscription lifecycle ---

    def subscribe(self) -> None:
        """(Re)build the mq subscription and re-attach our listener.

        refresh_mq() only subscribes devices whose .set_up is truthy and creates
        a fresh mq (dropping listeners), so this is also the re-subscribe path.
        """
        self.manager.refresh_mq()
        self.manager.mq.add_message_listener(self.on_message)
        log("info", "subscribed to mq", device_id=self.cfg.device_id)

    def supervisor(self) -> None:
        """Watchdog + heartbeat loop; blocks until stop_event is set."""
        base_backoff = 5.0
        backoff = base_backoff
        next_resubscribe = 0.0
        last_heartbeat = time.monotonic()
        while not self.stop_event.wait(1.0):
            now = time.monotonic()
            idle = now - self._last_push
            if now - last_heartbeat >= 60:
                last_heartbeat = now
                log("info", "heartbeat", pushes=self.pushes, posts=self.posts,
                    post_errors=self.post_errors, dropped=self.dropped,
                    last_push_age_s=round(idle, 1))
            if idle < self.cfg.watchdog_s:
                backoff = base_backoff
                continue
            if now < next_resubscribe:
                continue
            log("warn", "watchdog: no pushes, re-subscribing", idle_s=round(idle, 1), backoff_s=backoff)
            try:
                self.subscribe()
            except Exception as e:
                log("error", "re-subscribe failed", error=str(e))
            next_resubscribe = now + backoff
            backoff = min(backoff * 2, 300.0)

    def run(self) -> None:
        listener = FileTokenListener(self.cfg.token_file)
        self.manager = build_manager(self.cfg, listener)
        self.manager.update_device_cache()
        device = self.manager.device_map.get(self.cfg.device_id)
        if device is None:
            log("error", "device not found in cache", device_id=self.cfg.device_id,
                known=list(self.manager.device_map.keys()))
            raise SystemExit(1)
        # refresh_mq only subscribes devices flagged set_up.
        device.set_up = True
        self.subscribe()
        worker = threading.Thread(target=self.post_worker, name="post-worker", daemon=True)
        worker.start()
        log("info", "bridge started", target=self.cfg.target_url,
            phase_a_role=self.cfg.phase_a_role, watchdog_s=self.cfg.watchdog_s)
        self.supervisor()
        worker.join(timeout=7.0)
        try:
            if self.manager and self.manager.mq:
                self.manager.mq.stop()
        except Exception as e:
            log("error", "mq stop failed", error=str(e))
        log("info", "bridge stopped")


def build_manager(cfg: Config, listener: SharingTokenListener) -> Manager:
    with open(cfg.token_file) as f:
        bundle = json.load(f)
    token_response = {k: bundle[k] for k in ("t", "uid", "expire_time", "access_token", "refresh_token")}
    return Manager(
        bundle["client_id"],
        bundle["user_code"],
        bundle["terminal_id"],
        bundle["endpoint"],
        token_response,
        listener,
    )


def main() -> None:
    cfg = load_config()
    bridge = Bridge(cfg)

    def handle_signal(signum, _frame) -> None:
        log("info", "shutdown signal", signal=signum)
        bridge.stop_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    bridge.run()


if __name__ == "__main__":
    main()
