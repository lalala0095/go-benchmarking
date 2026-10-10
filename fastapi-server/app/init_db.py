"""One-time init before uvicorn forks workers: create ADK's session tables once.

DatabaseSessionService creates its tables lazily (prepare_tables → create_all)
on first use; doing that concurrently from several workers can race, so the
entrypoint runs this first.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from app.config import get_settings

log = logging.getLogger("init_db")


async def main(attempts: int = 60) -> int:
    from google.adk.sessions.database_session_service import DatabaseSessionService

    settings = get_settings()
    for i in range(1, attempts + 1):
        svc = DatabaseSessionService(db_url=settings.session_db_url)
        try:
            await svc.prepare_tables()
            log.info("ADK session tables ready")
            return 0
        except Exception as e:  # noqa: BLE001
            log.warning("session table init failed (%s), retry %d/%d", e, i, attempts)
            await asyncio.sleep(1)
        finally:
            await svc.close()
    return 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    sys.exit(asyncio.run(main()))
