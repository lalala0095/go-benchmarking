import { describe, expect, it } from 'vitest';
import { SseParser, sseFrame } from '../src/sse.js';

describe('SseParser', () => {
  it('parses events split across arbitrary chunk boundaries', () => {
    const raw = 'event: meta\ndata: {"a":1}\n\nevent: token\ndata: {"text":"hé","seq":1}\n\n';
    const bytes = new TextEncoder().encode(raw);
    for (let split = 1; split < bytes.length; split++) {
      const p = new SseParser();
      const out = [...p.push(bytes.slice(0, split)), ...p.push(bytes.slice(split)), ...p.end()];
      expect(out).toEqual([
        { event: 'meta', data: '{"a":1}' },
        { event: 'token', data: '{"text":"hé","seq":1}' },
      ]);
    }
  });
  it('handles CRLF, comments, multi-line data and default event name', () => {
    const p = new SseParser();
    const out = p.push(': keepalive\r\ndata: line1\r\ndata: line2\r\n\r\nevent:done\ndata:{}\n\n');
    expect(out).toEqual([
      { event: 'message', data: 'line1\nline2' },
      { event: 'done', data: '{}' },
    ]);
  });
  it('dispatches a final event without trailing blank line at end()', () => {
    const p = new SseParser();
    expect(p.push('event: done\ndata: {"x":1}')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'done', data: '{"x":1}' }]);
  });
  it('waits for \\n after a trailing \\r', () => {
    const p = new SseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual([{ event: 'message', data: 'a' }]);
  });
  it('sseFrame round-trips', () => {
    const p = new SseParser();
    expect(p.push(sseFrame('sample', { a: 'x\ny' }))).toEqual([{ event: 'sample', data: '{"a":"x\\ny"}' }]);
  });
});
