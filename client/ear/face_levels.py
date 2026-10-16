"""Waveform frames for the kiosk face, mirrored from the real playback audio.

The ear daemon already receives the reply as raw PCM chunks and writes them to
the audio player. ``FaceLevelServer`` takes those same bytes, cuts them into
short frames of 33 waveform values, schedules each frame for the moment that
audio becomes audible, and serves the frames as Server-Sent Events so the
kiosk page on the same device can draw them.

Stdlib only. The server never raises into the caller: when it cannot bind its
port it logs a warning and every method becomes a no-op.
"""

import json
import logging
import os
import queue
import sys
import threading
import time
from array import array
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Deque, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

POINTS = 33
DEFAULT_LATENCY_MS = 300
PING_INTERVAL_S = 15.0
_ZERO_FRAME = [0] * POINTS


def _env_latency_ms() -> int:
    raw = os.environ.get("EAR_FACE_LATENCY_MS")
    if raw is None or not raw.strip():
        return DEFAULT_LATENCY_MS
    try:
        return int(float(raw))
    except ValueError:
        logger.warning("Ignoring invalid EAR_FACE_LATENCY_MS=%r", raw)
        return DEFAULT_LATENCY_MS


def frame_values(samples) -> List[int]:
    """Reduces one frame of samples to 33 values in -100..100.

    The frame is split into 33 near-equal segments; from each, the sample with
    the largest absolute value is kept, scaled from 16-bit to percent.
    """
    n = len(samples)
    values = []
    for i in range(POINTS):
        segment = samples[i * n // POINTS:(i + 1) * n // POINTS]
        peak = max(segment, key=abs) if len(segment) else 0
        values.append(max(-100, min(100, round(peak / 32768 * 100))))
    return values


class FaceLevelServer:
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8765,
        latency_ms: Optional[int] = None,
        frame_ms: int = 33,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self.host = host
        self.port = port
        self.latency_ms = _env_latency_ms() if latency_ms is None else latency_ms
        self.frame_ms = frame_ms
        self._now = now
        self._cond = threading.Condition()
        self._queue: Deque[Tuple[float, List[int]]] = deque()
        self._next_play = 0.0
        self._carry = array("h")
        self._carry_rate: Optional[int] = None
        self._clients: Set["queue.Queue"] = set()
        self._clients_lock = threading.Lock()
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._threads: List[threading.Thread] = []
        self._running = False
        self._disabled = False

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        if self._disabled or self._running:
            return
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # silence per-request logging
                pass

            def _cors(self):
                self.send_header("Access-Control-Allow-Origin", "*")

            def do_OPTIONS(self):
                self.send_response(204)
                self._cors()
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self):
                if self.path.split("?", 1)[0] != "/levels":
                    self.send_response(404)
                    self._cors()
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                server._serve_stream(self)

        try:
            self._httpd = ThreadingHTTPServer((self.host, self.port), Handler)
        except OSError as exc:
            logger.warning("Face level server disabled, cannot bind %s:%s: %s", self.host, self.port, exc)
            self._disabled = True
            self._httpd = None
            return
        self._httpd.daemon_threads = True
        self.port = self._httpd.server_address[1]
        self._running = True
        http_thread = threading.Thread(target=self._httpd.serve_forever, name="face-levels-http", daemon=True)
        sched_thread = threading.Thread(target=self._scheduler_loop, name="face-levels-sched", daemon=True)
        self._threads = [http_thread, sched_thread]
        for thread in self._threads:
            thread.start()

    def stop(self) -> None:
        with self._cond:
            self._running = False
            self._queue.clear()
            self._cond.notify_all()
        httpd, self._httpd = self._httpd, None
        if httpd is not None:
            try:
                httpd.shutdown()
                httpd.server_close()
            except Exception:  # pragma: no cover - best effort
                logger.debug("Face level server shutdown error", exc_info=True)
        with self._clients_lock:
            clients = list(self._clients)
        for client in clients:
            client.put(None)
        for thread in self._threads:
            if thread is not threading.current_thread():
                thread.join(timeout=2)
        self._threads = []

    # ------------------------------------------------------------------ audio in

    def push_pcm(self, pcm: bytes, sample_rate: int) -> None:
        """Queues 16-bit signed little-endian mono PCM for display."""
        if self._disabled:
            return
        try:
            self._push_pcm(pcm, int(sample_rate))
        except Exception:
            logger.debug("Face level push failed", exc_info=True)

    def _push_pcm(self, pcm: bytes, sample_rate: int) -> None:
        pcm = bytes(pcm)
        pcm = pcm[: len(pcm) - (len(pcm) % 2)]
        samples = array("h")
        samples.frombytes(pcm)
        if sys.byteorder == "big":  # pragma: no cover
            samples.byteswap()
        n = sample_rate * self.frame_ms // 1000
        if n < POINTS:
            return
        with self._cond:
            if sample_rate != self._carry_rate:
                self._carry = array("h")
                self._carry_rate = sample_rate
            data = self._carry + samples
            full = len(data) // n
            for k in range(full):
                values = frame_values(data[k * n:(k + 1) * n])
                play = max(self._now() + self.latency_ms / 1000, self._next_play)
                self._next_play = play + self.frame_ms / 1000
                self._queue.append((play, values))
            self._carry = data[full * n:]
            if full:
                self._cond.notify_all()

    def clear(self) -> None:
        """Drops everything queued and tells clients the mouth is flat."""
        if self._disabled:
            return
        with self._cond:
            self._queue.clear()
            self._next_play = 0.0
            self._carry = array("h")
            self._carry_rate = None
            self._cond.notify_all()
        self._broadcast(_ZERO_FRAME)

    # ------------------------------------------------------------------ scheduling

    def _pop_due(self) -> List[List[int]]:
        """Removes and returns the frames whose play time has arrived."""
        due = []
        now = self._now()
        with self._cond:
            while self._queue and self._queue[0][0] <= now:
                due.append(self._queue.popleft()[1])
        return due

    def _scheduler_loop(self) -> None:
        while True:
            with self._cond:
                if not self._running:
                    return
                if not self._queue:
                    self._cond.wait()
                    continue
                wait = self._queue[0][0] - self._now()
                if wait > 0:
                    self._cond.wait(timeout=wait)
                    continue
            for values in self._pop_due():
                self._broadcast(values)

    # ------------------------------------------------------------------ clients

    def _broadcast(self, values: List[int]) -> None:
        payload = ("event: frame\ndata: %s\n\n" % json.dumps(values)).encode("ascii")
        with self._clients_lock:
            clients = list(self._clients)
        for client in clients:
            client.put(payload)

    def _serve_stream(self, handler: BaseHTTPRequestHandler) -> None:
        outbox: "queue.Queue" = queue.Queue()
        with self._clients_lock:
            self._clients.add(outbox)
        try:
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.send_header("Cache-Control", "no-cache")
            handler.send_header("Access-Control-Allow-Origin", "*")
            handler.end_headers()
            handler.wfile.write(b": ping\n\n")
            handler.wfile.flush()
            while self._running:
                try:
                    chunk = outbox.get(timeout=PING_INTERVAL_S)
                except queue.Empty:
                    chunk = b": ping\n\n"
                if chunk is None:
                    break
                handler.wfile.write(chunk)
                handler.wfile.flush()
        except (OSError, ValueError):
            pass  # client went away
        finally:
            with self._clients_lock:
                self._clients.discard(outbox)
            handler.close_connection = True
