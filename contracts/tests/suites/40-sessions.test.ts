import { expect, it } from "vitest";
import { req } from "../lib/http.js";
import { expectError, expectResponse } from "../lib/schema.js";
import { crossDescribe, eachTarget, onAll } from "../lib/suite.js";
import { RUN_ID } from "../lib/targets.js";

const USER = `${RUN_ID}-sessions`;
const P = "/v1/sessions/{session_id}";

eachTarget("sessions", (t) => {
  it("create → get (empty history) → delete → 404", async () => {
    const c = await req(t, "/v1/sessions", { json: { user_id: USER } });
    expectResponse(c, "/v1/sessions", "post", 201);
    expect(c.body.user_id).toBe(USER);
    expect(c.body.session_id).toBeTruthy();
    const id = encodeURIComponent(c.body.session_id);

    const g = await req(t, `/v1/sessions/${id}?user_id=${USER}`);
    expectResponse(g, P, "get", 200);
    expect(g.body.session_id).toBe(c.body.session_id);
    expect(g.body.events).toEqual([]);

    const d = await req(t, `/v1/sessions/${id}?user_id=${USER}`, { method: "DELETE" });
    expect(d.status, d.text).toBe(204);
    expect(d.text).toBe("");

    const g2 = await req(t, `/v1/sessions/${id}?user_id=${USER}`);
    expectError(g2, 404, ["SESSION_NOT_FOUND", "NOT_FOUND"], "GET deleted session");
  });

  it("two creates give distinct session ids", async () => {
    const [a, b] = await Promise.all([
      req(t, "/v1/sessions", { json: { user_id: USER } }),
      req(t, "/v1/sessions", { json: { user_id: USER } }),
    ]);
    expect(a.body.session_id).not.toBe(b.body.session_id);
  });

  it("GET / DELETE unknown session → 404 Error", async () => {
    expectError(await req(t, `/v1/sessions/does-not-exist-${RUN_ID}?user_id=${USER}`), 404, ["SESSION_NOT_FOUND", "NOT_FOUND"], "GET unknown");
    expectError(
      await req(t, `/v1/sessions/does-not-exist-${RUN_ID}?user_id=${USER}`, { method: "DELETE" }),
      404,
      ["SESSION_NOT_FOUND", "NOT_FOUND"],
      "DELETE unknown",
    );
  });

  it("session is scoped to its user_id (other user → 404)", async () => {
    const c = await req(t, "/v1/sessions", { json: { user_id: USER } });
    expect(c.status).toBe(201);
    const g = await req(t, `/v1/sessions/${encodeURIComponent(c.body.session_id)}?user_id=${USER}-other`);
    expectError(g, 404, ["SESSION_NOT_FOUND", "NOT_FOUND"], "GET with another user_id");
  });

  it("bad requests → 400 Error", async () => {
    expectError(await req(t, "/v1/sessions", { json: {} }), 400, ["BAD_REQUEST"], "POST without user_id");
    expectError(await req(t, "/v1/sessions", { raw: "{oops" }), 400, ["BAD_REQUEST"], "POST malformed JSON");
    const c = await req(t, "/v1/sessions", { json: { user_id: USER } });
    expectError(await req(t, `/v1/sessions/${encodeURIComponent(c.body.session_id)}`), 400, ["BAD_REQUEST"], "GET without user_id");
  });
});

crossDescribe("sessions parity", () => {
  it("unknown session error code identical", async () => {
    const r = await onAll((t) => req(t, `/v1/sessions/nope-${RUN_ID}?user_id=${USER}`));
    expect(r.py!.body?.code).toBe(r.go!.body?.code);
  });
});
