"""ADK agents_dir entry for get_fast_api_app: exposes the Gemini agent as root_agent.

ADK's native routes (/list-apps, /run, /run_sse, /apps/bench_agent/...) load this
package; it reuses the same per-worker agent instance as the /v1 routes.
"""

from app.agent import get_bundle

root_agent = get_bundle().gemini_agent
