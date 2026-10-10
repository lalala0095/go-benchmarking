import type {
  ChatRequest, ChatStreamEvent, Conversation, ConversationDetail, CreateConversationRequest, IngestResponse, KbIngestRequest,
  LiveSample, PerTarget, Fallible, PlatformInfo, RagStats, RunDetail, RunStatus, RunStreamEvent, RunSummary, Scenario,
  SearchResponse, StartRunRequest, StaticMeasurement, Target, TargetsResponse, PlatformMode,
} from '../types';

export type DxNotes = Record<Target, { markdown: string; updated_at: string }>;
export type StartRunResult =
  | { ok: true; run_id: string }
  | { ok: false; status: number; error: string; active_run_id?: string };
export interface RunFilters { scenario?: string; platform?: PlatformMode | ''; status?: RunStatus | ''; limit?: number }
export interface KbSearchParams { q: string; k?: number; mode: 'hybrid' | 'vector' | 'fts'; embedder: 'mock' | 'gemini' }
export type ExportFormat = 'json' | 'csv' | 'md';
export interface Unsubscribe { (): void }
export interface StreamHandlers<T> { onEvent: (e: T) => void; onError?: (err: unknown) => void; onOpen?: () => void }

export interface Api {
  health(): Promise<{ ok: true }>;
  targets(): Promise<TargetsResponse>;
  platform(): Promise<PlatformInfo>;

  conversations(): Promise<Conversation[]>;
  createConversation(req: CreateConversationRequest): Promise<Conversation>;
  conversation(id: string): Promise<ConversationDetail>;
  /** Streams ChatStreamEvents; resolves when the stream closes. */
  chat(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void, signal?: AbortSignal): Promise<void>;

  kbStats(): Promise<PerTarget<Fallible<RagStats>>>;
  kbIngest(req: KbIngestRequest): Promise<PerTarget<Fallible<IngestResponse>>>;
  kbUpload(files: File[]): Promise<PerTarget<Fallible<IngestResponse>>>;
  kbSearch(p: KbSearchParams): Promise<PerTarget<Fallible<SearchResponse>>>;

  live(h: StreamHandlers<LiveSample>): Unsubscribe;

  scenarios(): Promise<Scenario[]>;
  startRun(req: StartRunRequest): Promise<StartRunResult>;
  runs(f?: RunFilters): Promise<RunSummary[]>;
  run(id: string): Promise<RunDetail>;
  runStream(id: string, h: StreamHandlers<RunStreamEvent>): Unsubscribe;
  cancelRun(id: string): Promise<void>;
  deleteRun(id: string): Promise<void>;
  compare(a: string, b: string): Promise<{ a: RunDetail; b: RunDetail }>;
  exportRun(id: string, format: ExportFormat): Promise<{ blob: Blob; filename: string }>;

  staticMeasurements(): Promise<StaticMeasurement[]>;
  measureStatic(): Promise<void>;
  dxNotes(): Promise<DxNotes>;
  saveDxNote(target: Target, markdown: string): Promise<void>;
  report(): Promise<string>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}
