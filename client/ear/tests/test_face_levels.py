import json
import math
import os
import socket
import struct
import unittest
from unittest import mock

from client.ear.face_levels import FaceLevelServer, FACE_POINTS

RATE = 24000
FRAME_LEN = 792  # 33 ms at 24 kHz


def _pcm(samples) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


def _sine(n: int, amplitude: int = 16000, freq: float = 440.0, rate: int = RATE) -> list:
    return [int(amplitude * math.sin(2 * math.pi * freq * i / rate)) for i in range(n)]


class FakeClock:
    def __init__(self, t: float = 10.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


class FaceLevelServerTests(unittest.TestCase):
    def make(self, latency_ms: float = 300, clock: FakeClock = None) -> FaceLevelServer:
        self.clock = clock or FakeClock()
        return FaceLevelServer(port=0, latency_ms=latency_ms, now=self.clock)

    def test_sine_chunk_yields_one_frame_near_amplitude(self):
        srv = self.make()
        srv.push_pcm(_pcm(_sine(FRAME_LEN)), RATE)
        self.assertEqual(len(srv._queue), 1)
        _, values = srv._queue[0]
        self.assertEqual(len(values), FACE_POINTS)
        self.assertTrue(all(-100 <= v <= 100 for v in values))
        peak = max(abs(v) for v in values)
        # 16000 / 32768 * 100 is about 49; segment peaks land near the crest.
        self.assertTrue(40 <= peak <= 50, peak)

    def test_half_frame_carries_over_and_completes(self):
        srv = self.make()
        samples = _sine(FRAME_LEN)
        srv.push_pcm(_pcm(samples[:396]), RATE)
        self.assertEqual(len(srv._queue), 0)
        srv.push_pcm(_pcm(samples[396:]), RATE)
        self.assertEqual(len(srv._queue), 1)
        self.assertEqual(len(srv._carry), 0)

    def test_silence_yields_all_zero_frame(self):
        srv = self.make()
        srv.push_pcm(_pcm([0] * FRAME_LEN), RATE)
        _, values = srv._queue[0]
        self.assertEqual(values, [0] * FACE_POINTS)

    def test_first_frame_plays_after_latency_then_frame_spaced(self):
        srv = self.make(latency_ms=300)
        srv.push_pcm(_pcm([1000] * (FRAME_LEN * 3)), RATE)
        times = [t for t, _ in srv._queue]
        self.assertEqual(len(times), 3)
        self.assertAlmostEqual(times[0], 10.0 + 0.3, places=9)
        self.assertAlmostEqual(times[1] - times[0], 0.033, places=9)
        self.assertAlmostEqual(times[2] - times[1], 0.033, places=9)

    def test_chunk_after_gap_schedules_at_now_plus_latency(self):
        clock = FakeClock(10.0)
        srv = self.make(latency_ms=300, clock=clock)
        srv.push_pcm(_pcm([1000] * FRAME_LEN), RATE)
        clock.t = 20.0  # the earlier frame has long played out
        srv._queue.clear()
        srv.push_pcm(_pcm([1000] * FRAME_LEN), RATE)
        t, _ = srv._queue[0]
        self.assertAlmostEqual(t, 20.3, places=9)

    def test_clear_empties_queue_and_resets_carry(self):
        srv = self.make()
        srv.push_pcm(_pcm([1000] * (FRAME_LEN * 2 + 10)), RATE)
        self.assertEqual(len(srv._queue), 2)
        self.assertEqual(len(srv._carry), 10)
        inbox = srv._subscribe()
        srv.clear()
        self.assertEqual(len(srv._queue), 0)
        self.assertEqual(len(srv._carry), 0)
        self.assertIsNone(srv._next_play)
        frame = inbox.get_nowait()
        self.assertEqual(frame, ("event: frame\ndata: " + json.dumps([0] * FACE_POINTS) + "\n\n").encode())

    def test_clear_resets_next_play_so_next_chunk_starts_at_latency(self):
        clock = FakeClock(10.0)
        srv = self.make(latency_ms=300, clock=clock)
        srv.push_pcm(_pcm([1000] * (FRAME_LEN * 5)), RATE)
        srv.clear()
        srv.push_pcm(_pcm([1000] * FRAME_LEN), RATE)
        t, _ = srv._queue[0]
        self.assertAlmostEqual(t, 10.3, places=9)

    def test_port_in_use_disables_server_without_raising(self):
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            blocker.bind(("127.0.0.1", 0))
            blocker.listen(1)
            port = blocker.getsockname()[1]
            srv = FaceLevelServer(port=port, latency_ms=300, now=FakeClock())
            with self.assertLogs("client.ear.face_levels", level="WARNING"):
                srv.start()
            self.assertFalse(srv.enabled)
            srv.push_pcm(_pcm(_sine(FRAME_LEN)), RATE)
            self.assertEqual(len(srv._queue), 0)
            srv.clear()
            srv.stop()
        finally:
            blocker.close()

    def test_odd_trailing_byte_is_dropped(self):
        srv = self.make()
        srv.push_pcm(_pcm(_sine(FRAME_LEN)) + b"\x7f", RATE)
        self.assertEqual(len(srv._queue), 1)
        self.assertEqual(len(srv._carry), 0)
        srv.push_pcm(b"\x01", RATE)
        self.assertEqual(len(srv._queue), 1)
        self.assertEqual(len(srv._carry), 0)

    def test_rate_change_resets_carry(self):
        srv = self.make()
        srv.push_pcm(_pcm([1000] * 396), RATE)
        self.assertEqual(len(srv._carry), 396)
        srv.push_pcm(_pcm([1000] * 100), 16000)  # 16 kHz frame is 528 samples
        self.assertEqual(len(srv._carry), 100)
        self.assertEqual(len(srv._queue), 0)

    def test_latency_env_default(self):
        with mock.patch.dict(os.environ, {"EAR_FACE_LATENCY_MS": "120"}):
            self.assertAlmostEqual(FaceLevelServer(port=0, now=FakeClock()).latency_ms, 120.0)
        with mock.patch.dict(os.environ, {"EAR_FACE_LATENCY_MS": "junk"}):
            self.assertAlmostEqual(FaceLevelServer(port=0, now=FakeClock()).latency_ms, 300.0)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertAlmostEqual(FaceLevelServer(port=0, now=FakeClock()).latency_ms, 300.0)

    def test_stream_serves_cors_frames_and_404(self):
        srv = FaceLevelServer(port=0, latency_ms=50)
        srv.start()
        self.addCleanup(srv.stop)
        self.assertTrue(srv.enabled)
        port = srv.port
        self.assertNotEqual(port, 0)

        sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.addCleanup(sock.close)
        sock.sendall(b"GET /levels HTTP/1.0\r\nHost: localhost\r\n\r\n")
        reader = sock.makefile("rb")
        status = reader.readline().decode()
        self.assertIn(" 200 ", status)
        headers = {}
        while True:
            line = reader.readline().decode().strip()
            if not line:
                break
            key, _, value = line.partition(":")
            headers[key.strip().lower()] = value.strip()
        self.assertEqual(headers.get("content-type"), "text/event-stream")
        self.assertEqual(headers.get("cache-control"), "no-cache")
        self.assertEqual(headers.get("access-control-allow-origin"), "*")

        # The handler subscribes before writing headers, so frames pushed now reach this client.
        srv.push_pcm(_pcm(_sine(FRAME_LEN * 2)), RATE)
        frames = []
        while len(frames) < 2:
            line = reader.readline().decode()
            if line.startswith("data: "):
                frames.append(json.loads(line[len("data: "):]))
        self.assertEqual(len(frames), 2)
        for values in frames:
            self.assertEqual(len(values), FACE_POINTS)

        other = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.addCleanup(other.close)
        other.sendall(b"GET /nope HTTP/1.0\r\n\r\n")
        self.assertIn(b" 404 ", other.recv(64))

        opts = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.addCleanup(opts.close)
        opts.sendall(b"OPTIONS /levels HTTP/1.0\r\n\r\n")
        reply = opts.recv(256)
        self.assertIn(b" 204 ", reply)
        self.assertIn(b"Access-Control-Allow-Origin: *", reply)


if __name__ == "__main__":
    unittest.main()
