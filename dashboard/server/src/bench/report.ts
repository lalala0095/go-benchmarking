// Decision Report (docs/01-PRD.md §10), rendered from the latest complete run per scenario/platform.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Layer, PlatformMode, RunDetail, StaticMeasurement, SummaryRow, Target } from '../../../shared/api.js';
import { median, pctChange } from './analyze.js';
import { fmt } from './export.js';

export interface ReportInput {
  generated_at: string;
  git_sha: string | null;
  platform: PlatformMode;
  runs: RunDetail[];
  static: StaticMeasurement[];
  dx: Record<Target, { markdown: string; updated_at: string }>;
}

const LAYERS: { layer: Layer; title: string }[] = [
  { layer: 'L1', title: 'L1 — Raw runtime (HTTP, JSON, CPU)' },
  { layer: 'L2', title: 'L2 — Database + RAG retrieval path' },
  { layer: 'L3', title: 'L3 — Agent overhead (mock LLM)' },
  { layer: 'L4', title: 'L4 — Real end-to-end (Gemini)' },
  { layer: 'static', title: 'Static — cold start' },
];

const ratio = (g: number | null | undefined, p: number | null | undefined): number | null =>
  typeof g === 'number' && typeof p === 'number' && p !== 0 ? g / p : null;
const x = (r: number | null): string => (r === null ? 'n/a' : `${r.toFixed(2)}×`);

type S = { go: SummaryRow; python: SummaryRow; run: RunDetail };

/** Pick the preferred run per scenario (compose preferred when present on both platforms). */
function byScenario(runs: RunDetail[], platform?: PlatformMode): Map<string, S> {
  const m = new Map<string, S>();
  const sorted = [...runs].sort((a, b) => (a.run.platform === 'compose' ? -1 : 1) - (b.run.platform === 'compose' ? -1 : 1));
  for (const r of sorted) {
    if (platform && r.run.platform !== platform) continue;
    if (!r.summary.go || !r.summary.python) continue;
    if (!m.has(r.run.scenario)) m.set(r.run.scenario, { go: r.summary.go, python: r.summary.python, run: r });
  }
  return m;
}

function layerTable(rows: S[], layer: Layer): string[] {
  const out: string[] = [];
  const chat = layer === 'L3' || layer === 'L4';
  const isStatic = layer === 'static';
  if (isStatic) {
    out.push('| Scenario | Platform | Go p50 (ms) | Python p50 (ms) | Δ |', '|---|---|---:|---:|---:|');
    for (const r of rows) out.push(`| ${r.run.run.scenario} | ${r.run.run.platform} | ${fmt(r.go.p50_ms, 0)} | ${fmt(r.python.p50_ms, 0)} | ${pctChange(r.go.p50_ms, r.python.p50_ms)} |`);
    return out;
  }
  out.push(`| Scenario | Platform | Go RPS | Py RPS | RPS ratio | Go p99 | Py p99 | p99 Δ | Go mem MB | Py mem MB | mem Δ |${chat ? ' Go overhead p50 | Py overhead p50 |' : ''} Flags |`,
    `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|${chat ? '---:|---:|' : ''}---|`);
  for (const r of rows) {
    const flags = r.run.run.suspect ? `suspect: ${r.run.run.suspect_reasons.join('; ')}` : '';
    out.push(`| ${r.run.run.scenario} | ${r.run.run.platform} | ${fmt(r.go.rps)} | ${fmt(r.python.rps)} | ${x(ratio(r.go.rps, r.python.rps))} | ` +
      `${fmt(r.go.p99_ms, 2)} | ${fmt(r.python.p99_ms, 2)} | ${pctChange(r.go.p99_ms, r.python.p99_ms)} | ` +
      `${fmt(r.go.mem_mb)} | ${fmt(r.python.mem_mb)} | ${pctChange(r.go.mem_mb, r.python.mem_mb)} |` +
      `${chat ? ` ${fmt(r.go.overhead_p50_ms, 2)} | ${fmt(r.python.overhead_p50_ms, 2)} |` : ''} ${flags} |`);
  }
  return out;
}

export interface Evidence {
  l1RpsRatio: number | null;
  l2RpsRatio: number | null;
  chat: S | null;
  burst: S | null;
  gemini: S | null;
  sleepIo: S | null;
  ragSearch: S | null;
}

export function evidence(runs: RunDetail[]): Evidence {
  const m = byScenario(runs);
  const layerRatio = (layer: Layer) => median([...m.values()].filter((s) => s.run.run.layer === layer).map((s) => ratio(s.go.rps, s.python.rps)));
  return {
    l1RpsRatio: layerRatio('L1'),
    l2RpsRatio: layerRatio('L2'),
    chat: m.get('chat-mock') ?? m.get('chat-mock-tool') ?? null,
    burst: m.get('chat-mock-burst') ?? null,
    gemini: m.get('chat-gemini') ?? null,
    sleepIo: m.get('sleep-io') ?? null,
    ragSearch: m.get('rag-search') ?? null,
  };
}

/** Recommendation matrix rows, filled from data (PRD §10.3). */
export function recommendations(e: Evidence): { project: string; recommendation: string }[] {
  const nd = '_Insufficient data — run the L3/L4 scenarios first._';
  const chatRps = e.chat ? ratio(e.chat.go.rps, e.chat.python.rps) : null;
  const chatMem = e.chat ? ratio(e.chat.go.mem_mb, e.chat.python.mem_mb) : null;
  const ovhDiff = e.chat && e.chat.go.overhead_p50_ms !== null && e.chat.python.overhead_p50_ms !== null
    ? e.chat.python.overhead_p50_ms - e.chat.go.overhead_p50_ms : null;
  const gemOvhDiff = e.gemini && e.gemini.go.overhead_p50_ms !== null && e.gemini.python.overhead_p50_ms !== null
    ? e.gemini.python.overhead_p50_ms - e.gemini.go.overhead_p50_ms : ovhDiff;
  const e2e = e.gemini ? median([e.gemini.go.p50_ms, e.gemini.python.p50_ms]) : null;
  const share = gemOvhDiff !== null && e2e ? Math.abs(gemOvhDiff) / e2e : null;
  const burstP99 = e.burst ? ratio(e.burst.go.p99_ms, e.burst.python.p99_ms) : null;
  const goGatewayWin = (chatRps !== null && chatRps >= 1.5) || (chatMem !== null && chatMem <= 0.6) || (burstP99 !== null && burstP99 <= 0.6);

  let thin: string;
  if (share !== null && e2e !== null) {
    thin = share < 0.05
      ? `**Python (FastAPI + ADK-Python).** The framework-overhead difference (${fmt(Math.abs(gemOvhDiff!), 2)} ms) is ${(share * 100).toFixed(1)}% of the ${fmt(e2e, 0)} ms end-to-end Gemini latency, so the LLM dominates; Python's ADK maturity and ecosystem win.`
      : `**Go (ADK-Go).** The overhead difference (${fmt(Math.abs(gemOvhDiff!), 2)} ms) is ${(share * 100).toFixed(1)}% of the ${fmt(e2e, 0)} ms end-to-end latency — noticeable to users.`;
  } else if (ovhDiff !== null) {
    thin = `**Likely Python.** Mock-LLM overhead differs by ${fmt(Math.abs(ovhDiff), 2)} ms per request (${ovhDiff >= 0 ? 'Go lower' : 'Python lower'}), small next to typical Gemini latency (hundreds of ms). Run chat-gemini to confirm.`;
  } else thin = nd;

  let gateway: string;
  if (e.chat || e.burst || e.sleepIo) {
    const parts: string[] = [];
    if (chatRps !== null) parts.push(`${x(chatRps)} chat-mock RPS`);
    if (chatMem !== null) parts.push(`${pctChange(e.chat!.go.mem_mb, e.chat!.python.mem_mb)} memory`);
    if (burstP99 !== null) parts.push(`burst p99 ${pctChange(e.burst!.go.p99_ms, e.burst!.python.p99_ms)}`);
    if (e.sleepIo) parts.push(`${x(ratio(e.sleepIo.go.rps, e.sleepIo.python.rps))} sleep-io RPS`);
    gateway = goGatewayWin
      ? `**Go.** Go vs Python: ${parts.join(', ')}. Concurrency and memory density matter at this layer.`
      : `**Either.** Differences are under 1.5× (Go vs Python: ${parts.join(', ')}); pick by team skills.`;
  } else gateway = nd;

  const ml = `**Python.** The Python ecosystem (ML/data libraries, ADK-Python features) outweighs runtime cost here; measured cost of staying in Python: ` +
    `L1 RPS ratio ${x(e.l1RpsRatio)}, L2 ${x(e.l2RpsRatio)}` +
    (e.ragSearch ? `, rag-search ${x(ratio(e.ragSearch.go.rps, e.ragSearch.python.rps))}` : '') +
    (chatMem !== null ? `, chat memory ${pctChange(e.chat!.go.mem_mb, e.chat!.python.mem_mb)} (Go vs Python)` : '') + '.';

  let hybrid: string;
  if (e.chat || e.burst) {
    hybrid = goGatewayWin
      ? `**Worth it at high fan-out.** A Go gateway takes the connection/streaming load (${chatRps !== null ? x(chatRps) + ' RPS' : 'better burst behaviour'}${chatMem !== null ? `, ${pctChange(e.chat!.go.mem_mb, e.chat!.python.mem_mb)} memory` : ''}) while Python workers host the agents; costs an extra network hop and two codebases.`
      : '**Not justified by the data.** The Go advantage at the gateway layer is below 1.5×, so the extra hop and second codebase are not worth it.';
  } else hybrid = nd;

  return [
    { project: 'Thin agent API, LLM-bound, small team', recommendation: thin },
    { project: 'High-concurrency gateway / streaming fan-out', recommendation: gateway },
    { project: 'Data/ML-heavy agents needing the Python ecosystem', recommendation: ml },
    { project: 'Hybrid: Go gateway + Python agent workers', recommendation: hybrid },
  ];
}

function scaleSection(e: Evidence): string[] {
  const out: string[] = ['## 2. Does the difference matter at our expected scale?', ''];
  const lines: string[] = [];
  if (e.chat) {
    const c = e.chat;
    const cfg = c.run.run.config;
    lines.push(`- At **${cfg.concurrency} concurrent mock-chat users** (${c.run.run.scenario}), Go served ${fmt(c.go.rps)} RPS vs Python ${fmt(c.python.rps)} ` +
      `using ${fmt(c.go.mem_mb)} MB vs ${fmt(c.python.mem_mb)} MB RAM (${pctChange(c.go.mem_mb, c.python.mem_mb)}) and ${fmt(c.go.cpu_pct)}% vs ${fmt(c.python.cpu_pct)}% CPU.`);
    if (c.go.overhead_p50_ms !== null || c.python.overhead_p50_ms !== null) {
      lines.push(`- Server overhead per request (total − model − tool − session), p50: Go ${fmt(c.go.overhead_p50_ms, 2)} ms vs Python ${fmt(c.python.overhead_p50_ms, 2)} ms.`);
    }
  }
  if (e.gemini) {
    const g = e.gemini;
    lines.push(`- With **real Gemini**, end-to-end p50 is Go ${fmt(g.go.p50_ms, 0)} ms vs Python ${fmt(g.python.p50_ms, 0)} ms; TTFT p50 ${fmt(g.go.ttft_p50_ms, 0)} vs ${fmt(g.python.ttft_p50_ms, 0)} ms. ` +
      `Both are bound by the model when the overhead gap is a few ms.`);
  }
  if (e.burst) {
    const b = e.burst;
    lines.push(`- Under a **burst ramp** to ${b.run.run.config.concurrency} users: p99 Go ${fmt(b.go.p99_ms, 0)} ms vs Python ${fmt(b.python.p99_ms, 0)} ms; errors ${fmt(b.go.error_pct, 2)}% vs ${fmt(b.python.error_pct, 2)}%.`);
  }
  out.push(...(lines.length ? lines : ['_No chat runs yet — run chat-mock and chat-gemini._']), '');
  return out;
}

function k8sSection(runs: RunDetail[], all: RunDetail[], stat: StaticMeasurement[]): string[] {
  const k8s = runs.filter((r) => r.run.platform === 'k8s');
  if (!k8s.length) return [];
  const out: string[] = ['## 4. Kubernetes', ''];
  const so = k8s.find((r) => r.run.scenario === 'scale-out');
  if (so) {
    out.push('### Scale-out (HPA)', '', '| Target | Max replicas | First scale-up at (s) | RPS (median) | p99 (ms) |', '|---|---:|---:|---:|---:|');
    for (const t of ['go', 'python'] as Target[]) {
      const res = so.results.filter((r) => r.target === t);
      if (!res.length) continue;
      const first = so.samples.find((s) => s.target === t && (s.replicas ?? 0) > 1);
      out.push(`| ${t} | ${Math.max(...res.map((r) => r.max_replicas ?? 0))} | ${first ? first.t_offset_s : '–'} | ${fmt(so.summary[t]?.rps)} | ${fmt(so.summary[t]?.p99_ms, 0)} |`);
    }
    out.push('');
  }
  const ro = k8s.find((r) => r.run.scenario === 'rollout-disruption');
  if (ro) {
    out.push('### Rolling restart under load', '', '| Target | Errors during rollout | p99 (ms) | Max (ms) |', '|---|---:|---:|---:|');
    for (const t of ['go', 'python'] as Target[]) {
      const res = ro.results.filter((r) => r.target === t);
      if (!res.length) continue;
      out.push(`| ${t} | ${res.reduce((a, r) => a + (r.rollout_errors ?? 0), 0)} | ${fmt(median(res.map((r) => r.lat_p99_ms)), 0)} | ${fmt(Math.max(...res.map((r) => r.lat_max_ms ?? 0)), 0)} |`);
    }
    out.push('');
  }
  const ready = stat.filter((s) => s.platform === 'k8s' && (s.metric === 'pod_ready_ms' || s.metric === 'cold_start_ms'));
  if (ready.length) {
    out.push(`- Pod time-to-Ready (median): Go ${fmt(ready.find((s) => s.target === 'go')?.value, 0)} ms · Python ${fmt(ready.find((s) => s.target === 'python')?.value, 0)} ms`, '');
  }
  // platform dimension: same scenario on both platforms
  const compose = byScenario(all, 'compose');
  const kube = byScenario(all, 'k8s');
  const both = [...kube.keys()].filter((k) => compose.has(k));
  if (both.length) {
    out.push('### Platform cost (compose → k8s, RPS)', '', '| Scenario | Go compose | Go k8s | Δ | Python compose | Python k8s | Δ |', '|---|---:|---:|---:|---:|---:|---:|');
    for (const s of both) {
      const c = compose.get(s)!;
      const k = kube.get(s)!;
      out.push(`| ${s} | ${fmt(c.go.rps)} | ${fmt(k.go.rps)} | ${pctChange(k.go.rps, c.go.rps)} | ${fmt(c.python.rps)} | ${fmt(k.python.rps)} | ${pctChange(k.python.rps, c.python.rps)} |`);
    }
    out.push('');
  }
  return out;
}

export function renderReport(input: ReportInput): string {
  const runs = input.runs.filter((r) => r.run.status === 'complete');
  const e = evidence(runs);
  const out: string[] = [];
  out.push('# Decision Report — Go (ADK-Go) vs Python (ADK-Python + FastAPI)', '');
  out.push(`Generated ${input.generated_at}${input.git_sha ? ` · git \`${input.git_sha}\`` : ''} · dashboard platform: ${input.platform} · ${runs.length} run(s) considered (latest complete, non-suspect preferred, per scenario and platform).`, '');
  out.push('Ratios are Go ÷ Python; Δ is Go relative to Python (negative latency/memory Δ = Go better). Values are medians across repetitions.', '');

  out.push('## 1. How much faster or leaner is Go at each layer?', '');
  const all = [...byScenario(runs, 'compose').values(), ...[...byScenario(runs, 'k8s').values()]];
  for (const { layer, title } of LAYERS) {
    const rows = all.filter((s) => s.run.run.layer === layer).sort((a, b) => a.run.run.scenario.localeCompare(b.run.run.scenario) || a.run.run.platform.localeCompare(b.run.run.platform));
    out.push(`### ${title}`, '');
    if (!rows.length) { out.push('_No complete runs with both targets._', ''); continue; }
    out.push(...layerTable(rows, layer), '');
    if (layer !== 'static') {
      const r = median(rows.map((s) => ratio(s.go.rps, s.python.rps)));
      const m = median(rows.map((s) => ratio(s.go.mem_mb, s.python.mem_mb)));
      out.push(`**${layer} summary:** median Go/Python RPS ratio ${x(r)}, memory ratio ${x(m)}.`, '');
    }
  }

  out.push(...scaleSection(e));

  out.push('## 3. Recommendation matrix', '', '| Project type | Recommendation |', '|---|---|');
  for (const r of recommendations(e)) out.push(`| ${r.project} | ${r.recommendation.replace(/\|/g, '\\|')} |`);
  out.push('');

  out.push(...k8sSection(runs, runs, input.static));

  out.push('## Static characteristics', '');
  if (input.static.length) {
    const keys = [...new Set(input.static.map((s) => `${s.metric}|${s.platform}`))].sort();
    out.push('| Metric | Platform | Go | Python |', '|---|---|---:|---:|');
    for (const k of keys) {
      const [metric, platform] = k.split('|');
      const v = (t: Target) => input.static.find((s) => s.metric === metric && s.platform === platform && s.target === t)?.value;
      out.push(`| ${metric} | ${platform} | ${fmt(v('go'))} | ${fmt(v('python'))} |`);
    }
    out.push('');
  } else out.push('_None measured yet (POST /api/static/measure, cold-start scenario)._', '');

  out.push('## Developer experience notes', '');
  for (const t of ['go', 'python'] as Target[]) {
    out.push(`### ${t === 'go' ? 'Go' : 'Python'}`, '', input.dx[t]?.markdown?.trim() || '_No notes._', '');
  }

  out.push('## Runs used', '', '| Scenario | Platform | Run | Date | Config | Suspect |', '|---|---|---|---|---|---|');
  for (const r of [...runs].sort((a, b) => a.run.scenario.localeCompare(b.run.scenario))) {
    const c = r.run.config;
    out.push(`| ${r.run.scenario} | ${r.run.platform} | \`${r.run.id.slice(0, 8)}\` | ${r.run.created_at.slice(0, 10)} | c=${c.concurrency}${c.duration_s ? `, ${c.duration_s}s` : ''}${c.requests ? `, n=${c.requests}` : ''}, ${c.reps} rep(s)${c.py_profile ? `, ${c.py_profile}` : ''} | ${r.run.suspect ? 'yes' : 'no'} |`);
  }
  out.push('');
  return out.join('\n');
}

export async function saveReport(dir: string, markdown: string, now = new Date()): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const file = path.join(dir, `decision-report-${stamp}.md`);
  await writeFile(file, markdown);
  return file;
}
