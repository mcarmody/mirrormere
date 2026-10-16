"""Waveform levels for the Amos state face, served as Server-Sent Events.

The ear daemon hands every reply PCM chunk to ``FaceLevelServer.push_pcm``. The
chunk is cut into 33 ms frames; each frame becomes 33 waveform values (one per
mouth point). Each frame is scheduled for the moment its audio is audible
(``latency_ms`` after arrival, then back to back), and the scheduler thread
sends it to every client of ``GET /levels`` at that moment.

Stdlib only. Nothing here touches the playback path: a failed bind disables the
server and every method becomes a no-op.
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
from typing import Callable, Optional

log = logging.getLogger(__name__)

FACE_POINTS = 33
DEFAULT_LATENCY_MS = 300
PING_INTERVAL_S = 15.0
CLIENT_QUEUE_MAX = 256
_PING = b": ping\n\n"
_CORS = "Access-Control-Allow-Origin"


def _latency_from_env() -> float:
    raw = os.environ.get("EAR_FACE_LATENCY_MS")
    if raw is None or raw.strip() == "":
        return float(DEFAULT_LATENCY_MS)
    try:
        return float(raw)
    except ValueError:
        log.warning("EAR_FACE_LATENCY_MS=%r is not a number; using %d", raw, DEFAULT_LATENCY_MS)
        return float(DEFAULT_LATENCY_MS)


def _encode_frame(values) -> bytes:
    return ("event: frame\ndata: " + json.dumps(list(values)) + "\n\n").encode("ascii")


class _Server(ThreadingHTTPServer):
    daemon_threads = True


class _Handler(BaseHTTPRequestHandler):
    server_version = "FaceLevels/1"

    def log_message(self, fmt, *args):  # keep the ear daemon log quiet
        log.debug("face levels: " + fmt, *args)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header(_CORS, "*")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/levels":
            self.send_response(404)
            self.send_header(_CORS, "*")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        face = self.server.face  # type: ignore[attr-defined]
        inbox = face._subscribe()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header(_CORS, "*")
        self.end_headers()
        try:
            self.wfile.flush()
            while True:
                try:
                    item = inbox.get(timeout=PING_INTERVAL_S)
                except queue.Empty:
                    item = _PING
                if item is None:  # server stopping
                    break
                self.wfile.write(item)
                self.wfile.flush()
        except (OSError, ValueError):
            pass  # client went away; drop it silently
        finally:
            face._unsubscribe(inbox)


class FaceLevelServer:
    """Cuts PCM into 33-value waveform frames and streams them on /levels."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8765,
        latency_ms: Optional[float] = None,
        frame_ms: int = 33,
        now: Callable[[], float] = time.monotonic,
    ):
        self.host = host
        self.port = port
        self.latency_ms = float(latency_ms) if latency_ms is not None else _latency_from_env()
        self.frame_ms = int(frame_ms)
        self._now = now

        self._cond = threading.Condition()
        self._queue: deque = deque()  # (play_time, values), in play order
        self._next_play: Optional[float] = None
        self._carry = array("h")
        self._carry_rate: Optional[int] = None
        self._clients: list = []
        self._enabled = True
        self._closing = False

        self._httpd: Optional[_Server] = None
        self._serve_thread: Optional[threading.Thread] = None
        self._sched_thread: Optional[threading.Thread] = None

    @property
    def enabled(self) -> bool:
        return self._enabled

    def start(self) -> None:
        """Binds the port and starts the HTTP and scheduler threads. Never raises."""
        if not self._enabled or self._httpd is not None:
            return
        try:
            httpd = _Server((self.host, self.port), _Handler)
        except OSError as exc:
            log.warning("face levels disabled: cannot bind %s:%s (%s)", self.host, self.port, exc)
            self._enabled = False
            return
        httpd.face = self  # type: ignore[attr-defined]
        self._httpd = httpd
        self.port = httpd.server_address[1]
        self._closing = False
        self._serve_thread = threading.Thread(target=httpd.serve_forever, name="face-levels-http", daemon=True)
        self._sched_thread = threading.Thread(target=self._scheduler_loop, name="face-levels-sched", daemon=True)
        self._serve_thread.start()
        self._sched_thread.start()

    def stop(self) -> None:
        if not self._enabled:
            return
        with self._cond:
            self._closing = True
            self._queue.clear()
            for inbox in self._clients:
                try:
                    inbox.put_nowait(None)
                except queue.Full:
                    pass
            self._cond.notify_all()
        httpd = self._httpd
        self._httpd = None
        if httpd is not None:
            try:
                httpd.shutdown()
                httpd.server_close()
            except Exception:  # noqa: BLE001 - shutdown must not raise into the daemon
                log.exception("face levels: shutdown failed")
        for thread in (self._serve_thread, self._sched_thread):
            if thread is not None:
                thread.join(timeout=2.0)
        self._serve_thread = None
        self._sched_thread = None

    def push_pcm(self, pcm: bytes, sample_rate: int) -> None:
        """Converts 16-bit signed little-endian mono PCM to scheduled waveform frames."""
        if not self._enabled:
            return
        try:
            self._push_pcm(pcm, int(sample_rate))
        except Exception:  # noqa: BLE001 - a face bug must never reach playback
            log.exception("face levels: push_pcm failed")

    def clear(self) -> None:
        """Drops queued frames and sends one all-zero frame to connected clients."""
        if not self._enabled:
            return
        try:
            with self._cond:
                self._queue.clear()
                self._next_play = None
                self._carry = array("h")
                self._carry_rate = None
                self._broadcast_locked([0] * FACE_POINTS)
                self._cond.notify_all()
        except Exception:  # noqa: BLE001
            log.exception("face levels: clear failed")

    # Internals.

    def _push_pcm(self, pcm: bytes, sample_rate: int) -> None:
        if sample_rate <= 0:
            return
        frame_len = sample_rate * self.frame_ms // 1000
        if frame_len < FACE_POINTS:
            return
        even = pcm[: len(pcm) - (len(pcm) % 2)]
        samples = array("h")
        samples.frombytes(even)
        if sys.byteorder == "big":
            samples.byteswap()

        with self._cond:
            if sample_rate != self._carry_rate:
                self._carry = array("h")
                self._carry_rate = sample_rate
            buf = self._carry + samples if self._carry else samples
            full = (len(buf) // frame_len) * frame_len
            for start in range(0, full, frame_len):
                values = _frame_values(buf[start:start + frame_len])
                play_at = self._now() + self.latency_ms / 1000.0
                if self._next_play is not None and self._next_play > play_at:
                    play_at = self._next_play
                self._next_play = play_at + self.frame_ms / 1000.0
                self._queue.append((play_at, values))
            self._carry = buf[full:]
            self._cond.notify_all()

    def _scheduler_loop(self) -> None:
        with self._cond:
            while not self._closing:
                if not self._queue:
                    self._cond.wait()
                    continue
                play_at, values = self._queue[0]
                delay = play_at - self._now()
                if delay > 0:
                    self._cond.wait(delay)
                    continue
                self._queue.popleft()
                self._broadcast_locked(values)

    def _broadcast_locked(self, values) -> None:
        frame = _encode_frame(values)
        for inbox in self._clients:
            try:
                inbox.put_nowait(frame)
            except queue.Full:
                pass  # a stalled client misses a frame; it catches up on the next one

    def _subscribe(self) -> "queue.Queue":
        inbox: queue.Queue = queue.Queue(maxsize=CLIENT_QUEUE_MAX)
        with self._cond:
            self._clients.append(inbox)
        return inbox

    def _unsubscribe(self, inbox) -> None:
        with self._cond:
            if inbox in self._clients:
                self._clients.remove(inbox)


def _frame_values(frame) -> list:
    """33 values: the peak sample of each of 33 near-equal segments, scaled to -100..100."""
    n = len(frame)
    values = []
    for i in range(FACE_POINTS):
        a = i * n // FACE_POINTS
        b = (i + 1) * n // FACE_POINTS
        peak = max(frame[a:b], key=abs)
        value = round(peak / 32768 * 100)
        values.append(max(-100, min(100, value)))
    return values
