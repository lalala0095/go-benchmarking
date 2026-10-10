import type { Target } from "./targets.js";

export interface SseEvent {
  event: string;
  data: any;
  rawData: string;
  /** ms since the request was sent */
  at: number;
  /** number of `data:` lines (contract: exactly one) */
  dataLines: number;
}

export interface SseResult {
  status: number;
  headers: Headers;
  events: SseEvent[];
  /** body text when the server did not answer with an event stream */
  text: string;
  ms: number;
  /** true if bytes arrived after the terminal done/error event */
  trailingData: boolean;
}

function parseBlock(block: string, at: number): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && event === "message") return null;
  const rawData = data.join("\n");
  let parsed: any;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    parsed = undefined;
  }
  return { event, data: parsed, rawData, at, dataLines: data.length };
}

/** POST a JSON body and collect the whole SSE stream (until the server closes it). */
export async function postSse(t: Target, path: string, body: unknown, timeoutMs = 60_000): Promise<SseResult> {
  const t0 = performance.now();
  const r = await fetch(t.url + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream") || !r.body) {
    const text = await r.text();
    return { status: r.status, headers: r.headers, events: [], text, ms: performance.now() - t0, trailingData: false };
  }
  const events: SseEvent[] = [];
  const dec = new TextDecoder();
  let buf = "";
  let terminal = false;
  let trailingData = false;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    const at = performance.now() - t0;
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseBlock(block, at);
      if (!ev) continue;
      if (terminal) trailingData = true;
      events.push(ev);
      if (ev.event === "done" || ev.event === "error") terminal = true;
    }
  }
  buf += dec.decode();
  if (buf.trim() !== "") {
    const ev = parseBlock(buf, performance.now() - t0);
    if (ev) {
      if (terminal) trailingData = true;
      events.push(ev);
    }
  }
  return { status: r.status, headers: r.headers, events, text: "", ms: performance.now() - t0, trailingData };
}
