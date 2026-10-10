import { describe, expect, it } from 'vitest';
import { SSEParser, readSSE, type SSEMessage } from '../lib/sse';

describe('SSEParser', () => {
  it('parses events split across arbitrary chunk boundaries', () => {
    const p = new SSEParser();
    const out: SSEMessage[] = [];
    const raw = 'event: token\ndata: {"type":"token","text":"Hi"}\n\nevent: done\ndata: {"type":"done"}\n\n';
    for (let i = 0; i < raw.length; i += 3) out.push(...p.feed(raw.slice(i, i + 3)));
    expect(out).toEqual([
      { event: 'token', data: '{"type":"token","text":"Hi"}' },
      { event: 'done', data: '{"type":"done"}' },
    ]);
  });
  it('handles CRLF, comments, multi-line data, ids and default event name', () => {
    const p = new SSEParser();
    const out = p.feed(': keep-alive\r\nid: 7\r\ndata: line1\r\ndata: line2\r\n\r\n');
    expect(out).toEqual([{ event: 'message', data: 'line1\nline2', id: '7' }]);
  });
  it('handles a CR split from its LF across chunks', () => {
    const p = new SSEParser();
    const out = [...p.feed('data: a\r'), ...p.feed('\n\r'), ...p.feed('\n')];
    expect(out).toEqual([{ event: 'message', data: 'a' }]);
  });
  it('ignores events with no data and flushes trailing event on end()', () => {
    const p = new SSEParser();
    expect(p.feed('event: ping\n\n')).toEqual([]);
    expect(p.feed('data: tail')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'message', data: 'tail' }]);
  });
  it('keeps value whitespace after the first space', () => {
    const p = new SSEParser();
    expect(p.feed('data:  two\n\n')[0].data).toBe(' two');
    expect(p.feed('data:none\n\n')[0].data).toBe('none');
  });
});

describe('readSSE', () => {
  it('reads a ReadableStream of bytes, including multi-byte UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('event: token\ndata: {"text":"héllo ✓"}\n\n');
    const chunks = [bytes.slice(0, 27), bytes.slice(27, 29), bytes.slice(29)];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((x) => c.enqueue(x));
        c.close();
      },
    });
    const out: SSEMessage[] = [];
    await readSSE(stream, (m) => out.push(m));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].data).text).toBe('héllo ✓');
  });
});
