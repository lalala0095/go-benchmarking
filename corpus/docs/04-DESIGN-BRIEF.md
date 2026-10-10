# 04 — Design Brief (Dashboard)

## 1. Purpose and tone

This is an engineer's instrument panel, not a marketing site. It should feel like a precise lab tool: dense but calm, numbers first, and every comparison readable at a glance. One question drives every screen: **"Which side is better here, and by how much?"**

## 2. Principles

1. **Always paired.** Go and Python appear in fixed positions everywhere: **Go on the left, Python on the right**, and in that order in tables and legends.
2. **Deltas over raw values.** Every comparison shows the delta and ratio, for example "−68% p99" or "4.1× RPS", with the better side highlighted.
3. **Honest data.** Show sample size, reps, variance, and suspect flags. Never hide errors.
4. **Separate model time from server time.** Timing strips always split *model* from *overhead* visually, so Gemini latency never gets mistaken for server speed.
5. **Calm by default.** Motion only for streaming text and live charts.

## 3. Visual identity

| Token | Light | Dark (default) | Use |
|---|---|---|---|
| `--bg` | `#F7F8FA` | `#0E1116` | page |
| `--surface` | `#FFFFFF` | `#161B22` | cards / panes |
| `--border` | `#E3E6EB` | `#2A313C` | dividers |
| `--text` | `#14171C` | `#E6EAF0` | primary text |
| `--muted` | `#5B6472` | `#8B95A5` | labels |
| `--go` | `#0B7FAB` | `#3FB6E0` | Go series (Go-brand cyan family) |
| `--py` | `#B8860B` | `#F2C14E` | Python series (Python-yellow family) |
| `--better` | `#1A7F37` | `#3FB950` | winning delta |
| `--worse` | `#C93C37` | `#F85149` | losing delta |
| `--model` | `#8250DF` | `#A371F7` | model-time segment in timing bars |

- **Typography:** Inter for the UI and JetBrains Mono for all numbers, code, and IDs. Numbers use `font-variant-numeric: tabular-nums`.
- **Density:** 4 px spacing grid. Cards are 12 px radius with 1 px border and no heavy shadows.
- **Icons:** Lucide.
- The Go/Py colours are chosen to stay distinguishable for colour-blind users (blue vs yellow). Every series is also labelled with text, never colour alone.

## 4. Key screens

### 4.1 Chat (`/chat`), the landing page

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [Mode: (•) Mock  ( ) Gemini]   Targets: [x] Go [x] Python   [New chat]  │
├───────────────────────────────────┬──────────────────────────────────────┤
│  GO  · adk-go v2.5 · net/http     │  PYTHON · google-adk 2.x · FastAPI   │
│                                   │                                      │
│  👤 What's our electronics stock? │  👤 What's our electronics stock?   │
│  🔧 get_inventory_stats  3.1 ms   │  🔧 get_inventory_stats  5.8 ms     │
│  🤖 Electronics has 12,412 items… │  🤖 Electronics has 12,412 items…   │
│  ┌ timing bar ───────────────┐    │  ┌ timing bar ───────────────┐      │
│  │███████████████████▌ ░     │    │  │███████████████████▌ ░░    │      │
│  └ model 1.79s  overhead 4ms ┘    │  └ model 1.81s  overhead 19ms┘      │
│  TTFT 412ms · total 1.83s · ✓     │  TTFT 431ms · total 1.86s           │
├───────────────────────────────────┴──────────────────────────────────────┤
│  [ Type a message…                                         ] [Send ⏎]   │
└──────────────────────────────────────────────────────────────────────────┘
```

- The timing bar is a stacked horizontal bar: model (purple), tool, session/db, overhead. Hovering shows exact ms.
- A conversation summary in the footer gives the average overhead and TTFT per side across the conversation.
- A **Knowledge base** drawer (right edge, collapsible) shows doc, chunk, and Gemini-embedded chunk counts per side, an "Ingest default corpus" button with Go vs Py ingest timings, file upload, and a test-search box showing both result lists side by side with mode (hybrid / vector / fts) and embedder selectors, plus `embed_ms` and `db_ms`.
- `search_knowledge_base` tool chips list the retrieved sources (`docs/07-KUBERNETES.md › Probes`).

### 4.2 Live (`/live`)
- A 2-column grid of paired mini-charts (Go | Py): CPU %, Memory MB, RPS, p99 ms, threads/goroutines.
- A Postgres row below: connections, CPU, memory.
- A dashboard-health chip warns when the load generator's CPU is above 85%.

### 4.3 Benchmarks (`/bench`)
- Scenario cards grouped by layer (L1 Runtime, L2 Database, L3 Agent/mock, L4 Gemini, Static). Each card has a one-line explanation of *what it isolates*.
- A config drawer appears when you pick a card. Advanced fields (warm-up, reps, profile) start collapsed.
- **Running:** a phase stepper, a big live RPS number per side, and live latency and CPU charts.
- **Results:** a headline delta banner, then a percentile table (p50/p90/p95/p99/max, both sides plus a delta column), an overlaid latency histogram (log-x), RPS over time, CPU/mem over time, and derived metrics (RPS/core, RPS/100 MB).

### 4.4 History and Compare
- History is a dense sortable table with a suspect-flag icon and checkboxes. Selecting 2 enables **Compare**.
- Compare shows a two-column summary, delta badges, and overlaid charts. It also works **across platforms** (same scenario, Compose vs k8s), and each run carries a platform badge (`🐳 compose` / `⎈ k8s`).

### 4.5 About / Environment
- A platform panel. In k8s it shows the node, pods per target with status, restarts, QoS class, and HPA state.
- A versions table, resource limits, image size, cold start, idle memory, and dependency count.
- A DX notes editor per server (Markdown), saved to the DB.
- **Generate Decision Report.**

## 5. Components (build once, reuse)

`TargetBadge`, `PlatformBadge`, `DeltaBadge(value, betterWhen: "lower"|"higher")`, `TimingBar`, `MetricStrip`, `PairedChart`, `PercentileTable`, `ScenarioCard`, `RunPhaseStepper`, `HealthDot`, `SuspectFlag`, `StreamPane`.

## 6. States

- **Empty:** for example, "No runs yet. Start with *ping*, the 20-second smoke test."
- **Loading:** skeletons, never spinners on full pages.
- **Error:** an inline card with the error code and target. Errors on one side never blank the other side.
- **Offline target:** grey the pane, show a health dot and a "Retry" button. In k8s, show the pod status (for example `CrashLoopBackOff`, `ImagePullBackOff`) with a hint to run `kubectl describe`. That's handy during the labs.
- **Run preflight:** a quiet-mode checklist dialog (close heavy apps, power profile on performance) before every official run.

## 7. Accessibility and responsiveness

- WCAG AA contrast in both themes, full keyboard support for chat and the run controls, and `aria-live="polite"` on streaming panes.
- The primary target is ≥ 1280 px desktop. Below 900 px, the chat panes stack (Go first) and charts go single-column.
