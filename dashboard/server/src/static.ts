// Serves the built SPA (WEB_DIST) with index.html fallback for client-side routes.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Context } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function staticHandler(root: string) {
  const base = path.resolve(root);
  return async (c: Context) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('bad path', 400);
    }
    const file = path.resolve(base, '.' + rel);
    if (file !== base && !file.startsWith(base + path.sep)) return c.text('not found', 404);
    const tryFile = async (f: string) => {
      try {
        const st = await fs.stat(f);
        return st.isFile() ? f : null;
      } catch {
        return null;
      }
    };
    let found = await tryFile(file);
    const ext = path.extname(rel);
    // Client-side routes (no extension) fall back to index.html; missing assets are real 404s.
    if (!found && (ext === '' || ext === '.html')) found = await tryFile(path.join(base, 'index.html'));
    if (!found) return c.text('not found', 404);
    const body = await fs.readFile(found);
    const isIndex = found.endsWith(`${path.sep}index.html`);
    return c.body(body, 200, {
      'content-type': TYPES[path.extname(found)] ?? 'application/octet-stream',
      'cache-control': isIndex ? 'no-cache' : rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    });
  };
}
