// Dashboard DB access for conversations + chat_turns (db/init/dashboard-schema.psql).
import type pg from 'pg';
import type { ChatMode, ChatTurn, Conversation, Target, Timings } from '../../shared/api.js';
import { turnStateToChatTurn, type ChatStore, type TurnState } from './chat.js';

const CONV_COLS = 'id, title, mode, go_session_id, py_session_id, created_at';

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToConversation(r: Record<string, unknown>): Conversation {
  return {
    id: String(r.id),
    title: (r.title as string | null) ?? null,
    mode: r.mode as ChatMode,
    go_session_id: (r.go_session_id as string | null) ?? null,
    py_session_id: (r.py_session_id as string | null) ?? null,
    created_at: iso(r.created_at),
  };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function rowToTurn(r: Record<string, unknown>): ChatTurn {
  const timings: Timings | null =
    r.server_total_ms === null || r.server_total_ms === undefined
      ? null
      : {
          server_total_ms: Number(r.server_total_ms),
          first_token_ms: Number(r.server_ttft_ms ?? 0),
          model_ms: Number(r.model_ms ?? 0),
          tool_ms: Number(r.tool_ms ?? 0),
          session_ms: Number(r.session_ms ?? 0),
          overhead_ms: Number(r.overhead_ms ?? 0),
        };
  return {
    turn_index: Number(r.turn_index),
    target: r.target as Target,
    request_id: String(r.request_id),
    user_message: String(r.user_message),
    reply_text: (r.reply_text as string | null) ?? null,
    tool_calls: (r.tool_calls as ChatTurn['tool_calls']) ?? [],
    status: r.status === 'ok' ? 'ok' : 'error',
    error_code: (r.error_code as string | null) ?? null,
    timings,
    client_ttft_ms: num(r.client_ttft_ms),
    client_total_ms: num(r.client_total_ms),
    usage:
      r.input_tokens === null && r.output_tokens === null
        ? null
        : { input_tokens: Number(r.input_tokens ?? 0), output_tokens: Number(r.output_tokens ?? 0) },
    created_at: iso(r.created_at),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export class DashboardStore implements ChatStore {
  constructor(private readonly db: pg.Pool) {}

  async createConversation(mode: ChatMode, title: string | null): Promise<Conversation> {
    const r = await this.db.query(`INSERT INTO conversations (mode, title) VALUES ($1, $2) RETURNING ${CONV_COLS}`, [mode, title]);
    return rowToConversation(r.rows[0]);
  }

  async listConversations(limit = 50): Promise<Conversation[]> {
    const r = await this.db.query(`SELECT ${CONV_COLS} FROM conversations ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map(rowToConversation);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    if (!isUuid(id)) return null;
    const r = await this.db.query(`SELECT ${CONV_COLS} FROM conversations WHERE id = $1`, [id]);
    return r.rows[0] ? rowToConversation(r.rows[0]) : null;
  }

  async getTurns(id: string): Promise<ChatTurn[]> {
    const r = await this.db.query(`SELECT * FROM chat_turns WHERE conversation_id = $1 ORDER BY turn_index, target`, [id]);
    return r.rows.map(rowToTurn);
  }

  async nextTurnIndex(conversationId: string): Promise<number> {
    const r = await this.db.query(`SELECT COALESCE(MAX(turn_index), -1) + 1 AS n FROM chat_turns WHERE conversation_id = $1`, [conversationId]);
    return Number(r.rows[0].n);
  }

  async setSession(conversationId: string, target: Target, sessionId: string): Promise<void> {
    const col = target === 'go' ? 'go_session_id' : 'py_session_id';
    await this.db.query(`UPDATE conversations SET ${col} = $2 WHERE id = $1`, [conversationId, sessionId]);
  }

  async insertTurns(conversationId: string, turnIndex: number, userMessage: string, states: TurnState[]): Promise<ChatTurn[]> {
    const out: ChatTurn[] = [];
    for (const s of states) {
      const t = s.timings;
      const r = await this.db.query(
        `INSERT INTO chat_turns (conversation_id, turn_index, target, request_id, user_message, reply_text, tool_calls, status,
           error_code, server_total_ms, model_ms, tool_ms, session_ms, overhead_ms, server_ttft_ms, client_ttft_ms,
           client_total_ms, input_tokens, output_tokens)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (conversation_id, turn_index, target) DO NOTHING
         RETURNING created_at`,
        [
          conversationId,
          turnIndex,
          s.target,
          isUuid(s.request_id) ? s.request_id : crypto.randomUUID(),
          userMessage,
          s.reply || null,
          JSON.stringify(s.tool_calls),
          s.status === 'ok' ? 'ok' : 'error',
          s.error_code,
          t?.server_total_ms ?? null,
          t?.model_ms ?? null,
          t?.tool_ms ?? null,
          t?.session_ms ?? null,
          t?.overhead_ms ?? null,
          t?.first_token_ms ?? null,
          s.client_ttft_ms,
          s.client_total_ms,
          s.usage?.input_tokens ?? null,
          s.usage?.output_tokens ?? null,
        ],
      );
      out.push(turnStateToChatTurn(s, turnIndex, userMessage, iso(r.rows[0]?.created_at ?? new Date())));
    }
    return out;
  }
}
