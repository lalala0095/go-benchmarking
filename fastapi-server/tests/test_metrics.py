import httpx

from app.metrics import CgroupCollector, cgroup_limits, parse_cpu_max, parse_cpu_stat, parse_memory_max
from tests.fakes import install_fakes


def test_parse_cpu_stat():
    s = parse_cpu_stat("usage_usec 2500000\nuser_usec 1\nsystem_usec 2\nnr_periods 0\nthrottled_usec 125000\n")
    assert s["usage_usec"] == 2500000 and s["throttled_usec"] == 125000


def test_parse_limits():
    assert parse_cpu_max("max 100000\n") is None
    assert parse_cpu_max("200000 100000\n") == 2.0
    assert parse_cpu_max("150000 100000") == 1.5
    assert parse_memory_max("max\n") is None
    assert parse_memory_max("1073741824\n") == 1073741824


def test_cgroup_collector(tmp_path):
    (tmp_path / "cpu.stat").write_text("usage_usec 2500000\nthrottled_usec 500000\n")
    (tmp_path / "memory.current").write_text("123456\n")
    (tmp_path / "cpu.max").write_text("200000 100000\n")
    (tmp_path / "memory.max").write_text("1073741824\n")
    fams = {f.name: f.samples[0].value for f in CgroupCollector(tmp_path).collect()}
    assert fams == {
        "bench_cgroup_cpu_usage_seconds": 2.5,
        "bench_cgroup_cpu_throttled_seconds": 0.5,
        "bench_cgroup_memory_bytes": 123456.0,
    }
    assert cgroup_limits(tmp_path) == (2.0, 1073741824)


def test_cgroup_collector_missing_files(tmp_path):
    assert list(CgroupCollector(tmp_path).collect()) == []


async def test_metrics_endpoint_and_route_labels():
    install_fakes()
    from app.main import create_app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://t") as c:
        await c.get("/bench/ping")
        await c.get("/bench/sleep", params={"ms": 1})
        await c.get("/v1/sessions/abc", params={"user_id": "u"})
        r = await c.get("/metrics")
        assert r.status_code == 200
        text = r.text
    for name in (
        "bench_http_requests_total", "bench_http_request_duration_seconds_bucket", "bench_db_pool_in_use",
        "bench_db_pool_max", "bench_runtime_threads", "process_resident_memory_bytes", "process_cpu_seconds_total",
    ):
        assert name in text, name
    assert 'bench_http_requests_total{route="/bench/ping",status="200"}' in text
    assert 'route="/v1/sessions/{session_id}",status="404"' in text
