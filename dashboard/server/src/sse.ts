// Incremental text/event-stream parser (WHATWG semantics, subset: event/data/id; comments ignored).
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;
  private readonly decoder = new TextDecoder();

  /** Feed a chunk; returns the complete messages it finished. */
  push(chunk: Uint8Array | string): SseMessage[] {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // A lone trailing \r may be the first half of \r\n: wait for more input.
      if (m[0] === '\r' && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  /** Flush at end of stream (a final event without trailing blank line is dispatched). */
  end(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.buf.length) {
      const msg = this.line(this.buf);
      this.buf = '';
      if (msg) out.push(msg);
    }
    const last = this.line('');
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SseMessage | null {
    if (line === '') {
      if (this.data.length === 0 && this.event === '') return null;
      const msg: SseMessage = { event: this.event || 'message', data: this.data.join('\n') };
      if (this.id !== undefined) msg.id = this.id;
      this.event = '';
      this.data = [];
      return msg;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
    return null;
  }
}

/** Serialize one SSE frame. */
export function sseFrame(event: string, data: unknown): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${json.replace(/\n/g, '\ndata: ')}\n\n`;
}
