import asyncio

from google.adk.sessions.in_memory_session_service import InMemorySessionService

from app.instrument import TimedSessionService, Timings, current, start_request, timed_model_stream


def test_snapshot_math():
    t = Timings(start_ns=0, model_ns=700_000_000, tool_ns=50_000_000, session_ns=30_000_000)
    t.first_token_ns = 250_000_000
    t.end_ns = 800_000_000
    s = t.snapshot()
    assert s == {
        "server_total_ms": 800.0, "first_token_ms": 250.0, "model_ms": 700.0,
        "tool_ms": 50.0, "session_ms": 30.0, "overhead_ms": 20.0,
    }


def test_overhead_floored_at_zero_and_no_token():
    t = Timings(start_ns=0, model_ns=900, tool_ns=900, session_ns=900)
    t.end_ns = 1000
    s = t.snapshot()
    assert s["overhead_ms"] == 0 and s["first_token_ms"] == 0


async def test_timed_stream_counts_wall_time_until_last_chunk():
    async def gen():
        for _ in range(3):
            await asyncio.sleep(0.02)
            yield 1

    t = start_request()
    async for _ in timed_model_stream(gen()):
        await asyncio.sleep(0.03)  # consumer time between chunks counts as model time
    # 3 x 20ms model + 2 x 30ms consumer before the last chunk; the trailing 30ms does not count
    assert 115e6 <= t.model_ns < 150e6


async def test_child_tasks_share_accumulator():
    t = start_request()

    async def child():
        current().model_ns += 5

    await asyncio.gather(asyncio.create_task(child()), asyncio.create_task(child()))
    assert t.model_ns == 10


async def test_timed_session_service():
    ss = TimedSessionService(InMemorySessionService())
    t = start_request()
    s = await ss.create_session(app_name="a", user_id="u")
    assert await ss.get_session(app_name="a", user_id="u", session_id=s.id) is not None
    assert len((await ss.list_sessions(app_name="a", user_id="u")).sessions) == 1
    await ss.delete_session(app_name="a", user_id="u", session_id=s.id)
    assert t.session_ns > 0


async def test_no_accumulator_is_noop():
    import contextvars

    def run():
        from app.instrument import add_model, add_session

        add_model(5)
        add_session(5)
        return current()

    assert contextvars.Context().run(run) is None
