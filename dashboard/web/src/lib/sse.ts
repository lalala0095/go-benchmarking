// Minimal, spec-compliant(ish) incremental parser for text/event-stream.
// Used for POST /api/chat (EventSource cannot POST).

export interface SSEMessage {
  event: string; // defaults to "message"
  data: string;
  id?: string;
}

export class SSEParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName = '';
  private lastId: string | undefined;

  /** Feed a decoded text chunk; returns all messages completed by this chunk. */
  feed(chunk: string): SSEMessage[] {
    this.buffer += chunk;
    const out: SSEMessage[] = [];
    // Split on any line terminator; keep the trailing partial line in the buffer.
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      // A lone trailing \r might be the first half of \r\n — wait for more data.
      if (ch === '\r' && i === this.buffer.length - 1) break;
      const line = this.buffer.slice(start, i);
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
      const msg = this.processLine(line);
      if (msg) out.push(msg);
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Flush at end-of-stream: a final message without a trailing blank line is dispatched. */
  end(): SSEMessage[] {
    const out: SSEMessage[] = [];
    if (this.buffer.length) {
      const msg = this.processLine(this.buffer);
      if (msg) out.push(msg);
      this.buffer = '';
    }
    const msg = this.dispatch();
    if (msg) out.push(msg);
    return out;
  }

  private processLine(line: string): SSEMessage | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null; // comment / keep-alive
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        this.lastId = value;
        break;
      default:
        break; // retry & unknown fields ignored
    }
    return null;
  }

  private dispatch(): SSEMessage | null {
    if (this.dataLines.length === 0) {
      this.eventName = '';
      return null;
    }
    const msg: SSEMessage = { event: this.eventName || 'message', data: this.dataLines.join('\n') };
    if (this.lastId !== undefined) msg.id = this.lastId;
    this.dataLines = [];
    this.eventName = '';
    return msg;
  }
}

/** Read a fetch Response body as SSE, invoking onMessage for each event. Resolves at end of stream. */
export async function readSSE(body: ReadableStream<Uint8Array>, onMessage: (m: SSEMessage) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const m of parser.feed(decoder.decode(value, { stream: true }))) onMessage(m);
    }
    for (const m of parser.feed(decoder.decode())) onMessage(m);
    for (const m of parser.end()) onMessage(m);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}
