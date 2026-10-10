"""Prometheus metrics (docs/02 §7) — multiprocess-aware, plus cgroup v2 container metrics.

With uvicorn --workers N each worker is a separate process, so prometheus_client
runs in multiprocess mode (PROMETHEUS_MULTIPROC_DIR, prepared by entrypoint.sh).
The cgroup collector reads the container's own cgroup files, so it covers every
worker; process_* metrics are summed over the whole uvicorn process tree.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from pathlib import Path
from typing import Iterable, Optional

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from prometheus_client.core import CounterMetricFamily, GaugeMetricFamily
from prometheus_client.registry import Collector

from app.instrument import now_ns

log = logging.getLogger(__name__)

MULTIPROC_DIR = os.environ.get("PROMETHEUS_MULTIPROC_DIR") or None
CGROUP_ROOT = Path(os.environ.get("CGROUP_ROOT", "/sys/fs/cgroup"))

HTTP_REQUESTS = Counter("bench_http_requests_total", "HTTP requests", ["route", "status"])
HTTP_DURATION = Histogram(
    "bench_http_request_duration_seconds",
    "HTTP request duration (until the response body completes)",
    ["route"],
    buckets=(0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
)
CHAT_OVERHEAD = Histogram(
    "bench_chat_overhead_seconds",
    "Chat server overhead (total - model - tool - session)",
    ["mode"],
    buckets=(0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5),
)
CHAT_MODEL = Histogram(
    "bench_chat_model_seconds",
    "Time spent awaiting the model per chat request",
    ["mode"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 1.25, 1.5, 2, 3, 5, 10, 30, 60),
)
_gauge_kw = {"multiprocess_mode": "livesum"}
DB_POOL_IN_USE = Gauge("bench_db_pool_in_use", "asyncpg connections checked out (all workers)", **_gauge_kw)
DB_POOL_MAX = Gauge("bench_db_pool_max", "asyncpg pool max size (all workers)", **_gauge_kw)
RUNTIME_THREADS = Gauge("bench_runtime_threads", "OS threads + asyncio tasks (all workers)", **_gauge_kw)


# ── cgroup v2 ─────────────────────────────────────────────────────────────


def parse_cpu_stat(text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2:
            try:
                out[parts[0]] = int(parts[1])
            except ValueError:
                pass
    return out


def parse_cpu_max(text: str) -> Optional[float]:
    """'max 100000' → None; '200000 100000' → 2.0."""
    parts = text.split()
    if len(parts) < 1 or parts[0] == "max":
        return None
    try:
        quota = int(parts[0])
        period = int(parts[1]) if len(parts) > 1 else 100000
    except ValueError:
        return None
    if period <= 0:
        return None
    return quota / period


def parse_memory_max(text: str) -> Optional[int]:
    t = text.strip()
    if not t or t == "max":
        return None
    try:
        return int(t)
    except ValueError:
        return None


def _read(root: Path, name: str) -> Optional[str]:
    try:
        return (root / name).read_text()
    except OSError:
        return None


def cgroup_limits(root: Path = CGROUP_ROOT) -> tuple[Optional[float], Optional[int]]:
    cpu = _read(root, "cpu.max")
    mem = _read(root, "memory.max")
    return (parse_cpu_max(cpu) if cpu else None, parse_memory_max(mem) if mem else None)


class CgroupCollector(Collector):
    def __init__(self, root: Path = CGROUP_ROOT):
        self.root = root

    def collect(self) -> Iterable:
        stat = _read(self.root, "cpu.stat")
        if stat is not None:
            s = parse_cpu_stat(stat)
            if "usage_usec" in s:
                c = CounterMetricFamily(
                    "bench_cgroup_cpu_usage_seconds", "Container CPU usage from cgroup cpu.stat usage_usec"
                )
                c.add_metric([], s["usage_usec"] / 1e6)
                yield c
            if "throttled_usec" in s:
                c = CounterMetricFamily(
                    "bench_cgroup_cpu_throttled_seconds", "Container CPU throttling from cgroup cpu.stat throttled_usec"
                )
                c.add_metric([], s["throttled_usec"] / 1e6)
                yield c
        mem = _read(self.root, "memory.current")
        if mem is not None:
            try:
                g = GaugeMetricFamily("bench_cgroup_memory_bytes", "Container memory from cgroup memory.current")
                g.add_metric([], float(int(mem.strip())))
                yield g
            except ValueError:
                pass


class ProcessTreeCollector(Collector):
    """process_resident_memory_bytes / process_cpu_seconds_total summed over all server processes."""

    def __init__(self, workers: int):
        self.workers = workers

    def _root(self):
        import psutil

        me = psutil.Process(os.getpid())
        if self.workers > 1:
            parent = me.parent()
            if parent is not None:
                return parent
        return me

    def collect(self) -> Iterable:
        try:
            import psutil

            root = self._root()
            procs = [root] + root.children(recursive=True)
            rss = 0
            cpu = 0.0
            for p in procs:
                try:
                    with p.oneshot():
                        rss += p.memory_info().rss
                        t = p.cpu_times()
                        cpu += t.user + t.system
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
        except Exception:  # pragma: no cover - best effort
            log.exception("process tree metrics failed")
            return
        g = GaugeMetricFamily("process_resident_memory_bytes", "Resident memory of all server processes (bytes)")
        g.add_metric([], float(rss))
        yield g
        c = CounterMetricFamily("process_cpu_seconds", "User+system CPU of all server processes (seconds)")
        c.add_metric([], cpu)
        yield c


_registry: Optional[CollectorRegistry] = None


def registry(workers: int = 1) -> CollectorRegistry:
    global _registry
    if _registry is None:
        if MULTIPROC_DIR:
            from prometheus_client import multiprocess

            reg = CollectorRegistry()
            multiprocess.MultiProcessCollector(reg)
            reg.register(ProcessTreeCollector(workers))
        else:
            from prometheus_client import PROCESS_COLLECTOR

            reg = REGISTRY
            try:  # replace the per-process collector with the process-tree one
                reg.unregister(PROCESS_COLLECTOR)
            except KeyError:
                pass
            reg.register(ProcessTreeCollector(workers))
        reg.register(CgroupCollector())
        _registry = reg
    return _registry


def render(workers: int = 1) -> tuple[bytes, str]:
    sample_runtime()
    return generate_latest(registry(workers)), CONTENT_TYPE_LATEST


# ── runtime sampler ───────────────────────────────────────────────────────


def sample_runtime() -> None:
    from app.db import pool_or_none

    pool = pool_or_none()
    if pool is not None:
        DB_POOL_IN_USE.set(pool.get_size() - pool.get_idle_size())
    try:
        tasks = len(asyncio.all_tasks())
    except RuntimeError:
        tasks = 0
    RUNTIME_THREADS.set(threading.active_count() + tasks)


async def sampler_loop(interval: float = 1.0) -> None:
    while True:
        try:
            sample_runtime()
        except Exception:  # pragma: no cover
            log.exception("metrics sampler failed")
        await asyncio.sleep(interval)


def mark_dead() -> None:
    if MULTIPROC_DIR:
        from prometheus_client import multiprocess

        try:
            multiprocess.mark_process_dead(os.getpid())
        except Exception:  # pragma: no cover
            pass


# ── ASGI middleware: request metrics + Server-Timing ──────────────────────


def _route_label(scope) -> str:
    route = scope.get("route")
    path = getattr(route, "path", None)
    return path if path else "unmatched"


class MetricsMiddleware:
    """Pure ASGI middleware (no BaseHTTPMiddleware buffering)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        t0 = now_ns()
        state = scope.setdefault("state", {})
        state["t0_ns"] = t0
        status_holder = [500]

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_holder[0] = message["status"]
                headers = message.get("headers") or []
                is_stream = False
                has_st = False
                for k, v in headers:
                    lk = k.lower()
                    if lk == b"content-type" and v.startswith(b"text/event-stream"):
                        is_stream = True
                    elif lk == b"server-timing":
                        has_st = True
                if not is_stream and not has_st:
                    value = f"total;dur={(now_ns() - t0) / 1e6:.3f}"
                    extra = state.get("server_timing")
                    if extra:
                        value += ", " + extra
                    message["headers"] = list(headers) + [(b"server-timing", value.encode())]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            route = _route_label(scope)
            HTTP_REQUESTS.labels(route, str(status_holder[0])).inc()
            HTTP_DURATION.labels(route).observe((now_ns() - t0) / 1e9)
