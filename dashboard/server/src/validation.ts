// zod schemas for /api request bodies and queries (shapes from dashboard/shared/api.ts).
import { z } from 'zod';

export const targetSchema = z.enum(['go', 'python']);
export const chatModeSchema = z.enum(['gemini', 'mock']);

export const createConversationSchema = z.object({
  mode: chatModeSchema,
  title: z.string().trim().max(200).optional(),
});

export const chatRequestSchema = z.object({
  conversation_id: z.string().uuid(),
  message: z.string().min(1).max(20_000).refine((s) => s.trim().length > 0, 'message must not be blank'),
  mode: chatModeSchema,
  targets: z
    .array(targetSchema)
    .min(1)
    .max(4)
    .transform((a) => [...new Set(a)]),
});

export const kbIngestSchema = z
  .object({
    force: z.boolean().optional(),
    embedders: z.array(z.enum(['gemini', 'mock'])).min(1).optional(),
  })
  .strict();

export const kbSearchSchema = z.object({
  q: z.string().trim().min(1).max(2_000),
  k: z.coerce.number().int().min(1).max(20).default(5),
  mode: z.enum(['hybrid', 'vector', 'fts']).default('hybrid'),
  embedder: z.enum(['mock', 'gemini']).default('mock'),
});

export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 50;
const UPLOAD_EXT = /\.(md|markdown|txt)$/i;

/** Safe "uploads/<name>" source from a client file name (basename only, conservative charset). */
export function uploadSource(fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  if (!UPLOAD_EXT.test(base)) return null;
  const clean = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
  if (!clean || !UPLOAD_EXT.test(clean)) return null;
  return `uploads/${clean}`;
}

export function zodMessage(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}
