import math
import socket
import struct
import time
import unittest

from client.ear.face_levels import FaceLevelServer


class FakeClock:
    def __init__(self, t=100.0):
        self.t = t

    def __call__(self):
        return self.t


def _sine_pcm(n_samples, amplitude=16000, cycles=6):
    return struct.pack(
        "<%dh" % n_samples,
        *[int(amplitude * math.sin(2 * math.pi * cycles * i / n_samples)) for i in range(n_samples)],
    )


def _silence(n_samples):
    return b"\x00\x00" * n_samples


def _make(clock=None, latency_ms=300, **kw):
    clock = clock or FakeClock()
    return FaceLevelServer(port=0, latency_ms=latency_ms, now=clock, **kw), clock


class FrameTests(unittest.TestCase):
    def test_sine_chunk_yields_one_frame(self):
        srv, _ = _make()
        srv.push_pcm(_sine_pcm(792), 24000)
        self.assertEqual(len(srv._queue), 1)
        values = srv._queue[0][1]
        self.assertEqual(len(values), 33)
        self.assertTrue(all(-100 <= v <= 100 for v in values))
        # 16000 / 32768 * 100 is about 49; the peak lands near the amplitude
        self.assertGreaterEqual(max(abs(v) for v in values), 45)
        self.assertLessEqual(max(abs(v) for v in values), 49)

    def test_half_frame_carries_over(self):
        srv, _ = _make()
        pcm = _sine_pcm(792)
        srv.push_pcm(pcm[: 396 * 2], 24000)
        self.assertEqual(len(srv._queue), 0)
        srv.push_pcm(pcm[396 * 2:], 24000)
        self.assertEqual(len(srv._queue), 1)
        whole, _ = _make()
        whole.push_pcm(pcm, 24000)
        self.assertEqual(srv._queue[0][1], whole._queue[0][1])

    def test_rate_change_resets_carry(self):
        srv, _ = _make()
        srv.push_pcm(_sine_pcm(400), 24000)
        srv.push_pcm(_sine_pcm(400), 16000)  # frame is 528 samples at 16 kHz
        self.assertEqual(len(srv._queue), 0)
        srv.push_pcm(_sine_pcm(128), 16000)
        self.assertEqual(len(srv._queue), 1)

    def test_silence_is_all_zeros(self):
        srv, _ = _make()
        srv.push_pcm(_silence(792), 24000)
        self.assertEqual(srv._queue[0][1], [0] * 33)

    def test_full_scale_clamps_to_100(self):
        srv, _ = _make()
        srv.push_pcm(struct.pack("<792h", *([-32768] * 792)), 24000)
        self.assertEqual(srv._queue[0][1], [-100] * 33)

    def test_odd_trailing_byte_dropped(self):
        srv, _ = _make()
        srv.push_pcm(_silence(792) + b"\x7f", 24000)
        self.assertEqual(len(srv._queue), 1)
        self.assertEqual(len(srv._carry), 0)

    def test_play_times(self):
        srv, clock = _make(latency_ms=300)
        srv.push_pcm(_silence(792 * 3), 24000)
        times = [t for t, _ in srv._queue]
        self.assertAlmostEqual(times[0], clock.t + 0.3)
        self.assertAlmostEqual(times[1] - times[0], 0.033)
        self.assertAlmostEqual(times[2] - times[1], 0.033)

    def test_chunk_after_gap_schedules_at_now_plus_latency(self):
        srv, clock = _make(latency_ms=300)
        srv.push_pcm(_silence(792), 24000)
        clock.t += 30.0
        srv.push_pcm(_silence(792), 24000)
        self.assertAlmostEqual(srv._queue[1][0], clock.t + 0.3)

    def test_latency_from_env(self):
        import os
        old = os.environ.get("EAR_FACE_LATENCY_MS")
        os.environ["EAR_FACE_LATENCY_MS"] = "120"
        try:
            self.assertEqual(FaceLevelServer(port=0).latency_ms, 120)
            self.assertEqual(FaceLevelServer(port=0, latency_ms=50).latency_ms, 50)
            os.environ["EAR_FACE_LATENCY_MS"] = "junk"
            self.assertEqual(FaceLevelServer(port=0).latency_ms, 300)
        finally:
            if old is None:
                del os.environ["EAR_FACE_LATENCY_MS"]
            else:
                os.environ["EAR_FACE_LATENCY_MS"] = old

    def test_pop_due_releases_only_due_frames(self):
        srv, clock = _make(latency_ms=100)
        srv.push_pcm(_silence(792 * 2), 24000)
        self.assertEqual(srv._pop_due(), [])
        clock.t += 0.1
        self.assertEqual(len(srv._pop_due()), 1)
        clock.t += 0.033
        self.assertEqual(len(srv._pop_due()), 1)
        self.assertEqual(len(srv._queue), 0)

    def test_clear_empties_queue_and_emits_zero_frame(self):
        srv, _ = _make()
        sent = []
        srv._broadcast = sent.append
        srv.push_pcm(_silence(792 * 2 + 100), 24000)
        self.assertEqual(len(srv._queue), 2)
        srv.clear()
        self.assertEqual(len(srv._queue), 0)
        self.assertEqual(len(srv._carry), 0)
        self.assertEqual(srv._next_play, 0.0)
        self.assertEqual(sent, [[0] * 33])


class ServerTests(unittest.TestCase):
    def _read_until(self, sock, marker, count=1, timeout=3.0):
        sock.settimeout(timeout)
        buf = b""
        deadline = time.time() + timeout
        while buf.count(marker) < count and time.time() < deadline:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        return buf

    def test_streams_two_frames_over_http(self):
        srv = FaceLevelServer(port=0, latency_ms=0)
        srv.start()
        try:
            port = srv._httpd.server_address[1]
            sock = socket.create_connection(("127.0.0.1", port), timeout=3)
            sock.sendall(b"GET /levels HTTP/1.1\r\nHost: x\r\n\r\n")
            head = self._read_until(sock, b": ping\n\n")
            text = head.decode("ascii").lower()
            self.assertIn("200", text.split("\r\n")[0])
            self.assertIn("content-type: text/event-stream", text)
            self.assertIn("cache-control: no-cache", text)
            self.assertIn("access-control-allow-origin: *", text)
            srv.push_pcm(_sine_pcm(792 * 2), 24000)
            body = self._read_until(sock, b"event: frame", count=2)
            self.assertEqual(body.count(b"event: frame\ndata: ["), 2)
            sock.close()
        finally:
            srv.stop()

    def test_clear_reaches_connected_client(self):
        srv = FaceLevelServer(port=0, latency_ms=0)
        srv.start()
        try:
            sock = socket.create_connection(("127.0.0.1", srv._httpd.server_address[1]), timeout=3)
            sock.sendall(b"GET /levels HTTP/1.1\r\nHost: x\r\n\r\n")
            self._read_until(sock, b": ping\n\n")
            srv.clear()
            body = self._read_until(sock, b"event: frame")
            self.assertIn(b"data: [" + b", ".join([b"0"] * 33) + b"]", body)
            sock.close()
        finally:
            srv.stop()

    def test_unknown_path_is_404_and_options_is_204_with_cors(self):
        srv = FaceLevelServer(port=0)
        srv.start()
        try:
            port = srv._httpd.server_address[1]
            sock = socket.create_connection(("127.0.0.1", port), timeout=3)
            sock.sendall(b"GET /nope HTTP/1.0\r\n\r\n")
            data = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
            sock.close()
            self.assertTrue(data.startswith(b"HTTP/1.0 404"))

            sock = socket.create_connection(("127.0.0.1", port), timeout=3)
            sock.sendall(b"OPTIONS /levels HTTP/1.0\r\n\r\n")
            data = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
            sock.close()
            self.assertIn(b" 204 ", data.split(b"\r\n")[0])
            self.assertIn(b"access-control-allow-origin: *", data.lower())
        finally:
            srv.stop()

    def test_cors_header_on_404(self):
        srv = FaceLevelServer(port=0)
        srv.start()
        try:
            sock = socket.create_connection(("127.0.0.1", srv._httpd.server_address[1]), timeout=3)
            sock.sendall(b"GET /x HTTP/1.0\r\n\r\n")
            data = sock.recv(4096).lower()
            sock.close()
            self.assertIn(b"access-control-allow-origin: *", data)
        finally:
            srv.stop()

    def test_port_in_use_disables_without_raising(self):
        blocker = socket.socket()
        blocker.bind(("127.0.0.1", 0))
        blocker.listen(1)
        try:
            srv = FaceLevelServer(port=blocker.getsockname()[1], latency_ms=0)
            with self.assertLogs("client.ear.face_levels", level="WARNING"):
                srv.start()
            srv.push_pcm(_sine_pcm(792), 24000)
            self.assertEqual(len(srv._queue), 0)
            srv.clear()
            srv.stop()
        finally:
            blocker.close()

    def test_stop_without_start_is_safe(self):
        srv, _ = _make()
        srv.stop()


if __name__ == "__main__":
    unittest.main()
