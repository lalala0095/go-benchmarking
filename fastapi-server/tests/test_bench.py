import json

import httpx
import pytest

from app.agent.tools import rfc3339, round_half_away
from app.bench.routes import cpu_hash, json_summary
from tests.conftest import CONTRACTS
from tests.fakes import install_fakes

EXPECTED = json.loads((CONTRACTS / "fixtures" / "expected-bench.json").read_text())
PAYLOAD = (CONTRACTS / "fixtures" / "json-10kb.json").read_bytes()


def test_cpu_hash_expected():
    assert cpu_hash(EXPECTED["cpu_n25"]["n"]) == EXPECTED["cpu_n25"]["hash"]


def test_json_summary_expected():
    out = json_summary(json.loads(PAYLOAD))
    assert out["item_count"] == EXPECTED["json"]["item_count"]
    assert out["total"] == EXPECTED["json"]["total"]
    assert len(out["echo"]) == EXPECTED["json"]["echo_len"]


@pytest.mark.parametrize(
    "x,want", [(1.005, 1.0), (2.675, 2.68), (0.125, 0.13), (-0.125, -0.13), (1.234999, 1.23), (16235.125, 16235.13)]
)
def test_round_half_away(x, want):
    # float inputs: matches Go math.Round(x*100)/100 on the same binary value
    assert round_half_away(x) == want


def test_rfc3339():
    from datetime import datetime, timedelta, timezone

    assert rfc3339(datetime(2026, 1, 2, 3, 4, 5, 999, tzinfo=timezone.utc)) == "2026-01-02T03:04:05Z"
    assert rfc3339(datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone(timedelta(hours=8)))) == "2026-01-02T03:04:05+08:00"


@pytest.fixture
async def client():
    install_fakes()
    from app.main import create_app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://t") as c:
        yield c


async def test_bench_http(client):
    r = await client.get("/bench/ping")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert r.headers["server-timing"].startswith("total;dur=")
    r = await client.post("/bench/json", content=PAYLOAD, headers={"content-type": "application/json"})
    body = r.json()
    assert body["item_count"] == 75 and body["total"] == 16235.13 and len(body["echo"]) == 10
    r = await client.get("/bench/cpu")
    assert r.json() == {"n": 25, "hash": EXPECTED["cpu_n25"]["hash"]}
    r = await client.get("/bench/cpu", params={"n": 25, "offload": 1})
    assert r.json()["hash"] == EXPECTED["cpu_n25"]["hash"]
    assert (await client.get("/bench/cpu", params={"n": 0})).status_code == 400
    assert (await client.get("/bench/cpu", params={"n": "x"})).json()["code"] == "BAD_REQUEST"
    r = await client.get("/bench/sleep", params={"ms": 5})
    assert r.json() == {"slept_ms": 5}
    assert (await client.get("/bench/sleep", params={"ms": 10001})).status_code == 400
    assert (await client.post("/bench/json", content=b"[1]")).status_code == 400


async def test_tools_current_time():
    from app.agent.tools import get_current_time
    from app.instrument import start_request

    t = start_request()
    r = await get_current_time("Asia/Manila")
    assert r["timezone"] == "Asia/Manila" and r["iso"].endswith("+08:00") and "note" not in r
    r = await get_current_time("Mars/Olympus")
    assert r["timezone"] == "UTC" and r["iso"].endswith("Z") and r["note"] == "unknown timezone, used UTC"
    assert [x.name for x in t.tools] == ["get_current_time", "get_current_time"]
