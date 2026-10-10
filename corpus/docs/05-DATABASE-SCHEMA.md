# 05 — Database Schema

One PostgreSQL 17 container with **three databases**:

| Database | Owner/user | Used by | Contains |
|---|---|---|---|
| `go_app` | `bench` | go-server | ADK-Go session tables (auto-managed) and the `app` schema (bench + tool data) |
| `py_app` | `bench` | fastapi-server | ADK-Python session tables (auto-managed) and the **identical** `app` schema |
| `dashboard` | `bench` | dashboard | conversations, benchmark runs, samples, and environment snapshots |

**Why separate app DBs instead of one shared DB?**
1. ADK-Go and ADK-Python create **their own, different session table schemas** (their names and columns can collide, for example `sessions`, `events`, `app_states`, `user_states`). Separate DBs avoid conflicts.
2. Writes from one server's benchmark can't bloat or lock the other's tables. Both DBs are seeded identically, so the comparison stays fair.
3. It mirrors reality: each service owns its database.

Both servers still share **one Postgres process** (as requested), so they compete equally for the same DB engine. That's why targets are benchmarked sequentially, never at the same time.

---

## 1. Bootstrap: `db/init/00-create-databases.sql`

```sql
-- runs once on first container boot (as POSTGRES_USER=bench)
CREATE DATABASE go_app;
CREATE DATABASE py_app;
CREATE DATABASE dashboard;
```

The same `db/init/` files are used in both modes. Compose bind-mounts them, and k8s mounts them from the `db-init` ConfigMap. So scripts must not reference paths outside `/docker-entrypoint-initdb.d`.

`db/init/05-apply.sh` runs `10-app-schema.sql` and `30-seed.sql` against **both** `go_app` and `py_app`, and `20-dashboard-schema.sql` against `dashboard`, using `psql -v ON_ERROR_STOP=1 -d <db> -f …`.

Postgres tuning (`command:` in compose): `-c shared_buffers=512MB -c max_connections=200 -c synchronous_commit=on -c random_page_cost=1.1`.

---

## 2. App schema (identical in `go_app` and `py_app`): `db/init/10-app-schema.sql`

```sql
CREATE SCHEMA IF NOT EXISTS app;

-- Read workload + agent tool data (100k deterministic rows)
CREATE TABLE app.bench_items (
    id          INTEGER      PRIMARY KEY,
    sku         TEXT         NOT NULL UNIQUE,
    name        TEXT         NOT NULL,
    category    TEXT         NOT NULL,          -- 10 categories: electronics, books, toys, …
    price       NUMERIC(10,2) NOT NULL,
    stock       INTEGER      NOT NULL,
    attributes  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX bench_items_category_idx ON app.bench_items (category);

-- Write workload (dashboard truncates it directly before each db-write run)
-- RAG tables: app.rag_documents, app.rag_chunks (pgvector HNSW x2 + tsvector GIN). Full DDL in docs/09-RAG.md §4.
-- Requires CREATE EXTENSION vector (image pgvector/pgvector:pg17).

CREATE TABLE app.bench_writes (
    id          BIGSERIAL    PRIMARY KEY,
    payload     JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

Seed (`30-seed.sql`) is deterministic, so both DBs hold byte-identical data:

```sql
INSERT INTO app.bench_items (id, sku, name, category, price, stock, attributes)
SELECT g,
       'SKU-' || lpad(g::text, 6, '0'),
       'Item ' || g,
       (ARRAY['electronics','books','toys','home','garden','sports','beauty','food','auto','office'])[1 + (g % 10)],
       round(((g * 7919) % 100000) / 100.0 + 1, 2),
       (g * 31) % 500,
       jsonb_build_object('color', (ARRAY['red','green','blue','black'])[1 + (g % 4)], 'weight_g', (g * 13) % 5000)
FROM generate_series(1, 100000) AS g;
ANALYZE app.bench_items;
```

All application SQL is **schema-qualified** (`app.bench_items`, `app.rag_chunks`, …), and the servers do **not** change `search_path`. ADK session tables are created by the ADK session services in `public`. Changing `search_path` would make GORM or SQLAlchemy create them in `app` instead.

### 2.1 ADK-managed session tables (do not hand-write)

| Server | Created by | Expected tables (verify at implementation) |
|---|---|---|
| go-server | `session/database` (GORM) `AutoMigrate` at startup | `sessions`, `events`, `app_states`, `user_states` (GORM naming) |
| fastapi-server | `DatabaseSessionService` (SQLAlchemy) `create_all` at startup | `sessions`, `events`, `app_states`, `user_states` |

These schemas belong to ADK and can change between ADK versions. **No application code may query them directly.** History goes through the ADK session service API (`GET /v1/sessions/{id}`). After implementation, record the actual DDL (`pg_dump -s`) in `docs/appendix-adk-session-ddl.md` for reference.

---

## 3. Dashboard schema: `db/init/20-dashboard-schema.sql`

```sql
CREATE TYPE target_impl  AS ENUM ('go', 'python');
CREATE TYPE run_status   AS ENUM ('queued','preflight','running','analyzing','complete','failed','cancelled');
CREATE TYPE chat_mode    AS ENUM ('gemini','mock');

-- ── Side-by-side chat ─────────────────────────────────────────────
CREATE TABLE conversations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title         TEXT,
    mode          chat_mode   NOT NULL,
    go_session_id TEXT,                     -- session id on go-server
    py_session_id TEXT,                     -- session id on fastapi-server
    user_id       TEXT        NOT NULL DEFAULT 'dashboard-user',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_turns (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_index       INTEGER     NOT NULL,
    target           target_impl NOT NULL,
    request_id       UUID        NOT NULL,
    user_message     TEXT        NOT NULL,
    reply_text       TEXT,
    tool_calls       JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{name,args,duration_ms}]
    status           TEXT        NOT NULL,                       -- ok | error
    error_code       TEXT,
    -- server-reported timings (from `done` event)
    server_total_ms  DOUBLE PRECISION,
    model_ms         DOUBLE PRECISION,
    tool_ms          DOUBLE PRECISION,
    session_ms       DOUBLE PRECISION,
    overhead_ms      DOUBLE PRECISION,
    server_ttft_ms   DOUBLE PRECISION,
    -- client-measured (dashboard)
    client_ttft_ms   DOUBLE PRECISION,
    client_total_ms  DOUBLE PRECISION,
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, turn_index, target)
);

-- ── Environment snapshot (one per run; dedupe by hash) ────────────
CREATE TABLE environments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hash          TEXT        NOT NULL UNIQUE,     -- sha256 of the json below
    platform      TEXT        NOT NULL,            -- compose | k8s
    git_sha       TEXT,
    host_info     JSONB       NOT NULL,            -- Ubuntu version, kernel, arch, nproc, RAM, power profile; k8s: k3s version, node, overlay
    go_info       JSONB       NOT NULL,            -- /v1/info + container limits + image size
    py_info       JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Benchmark runs ────────────────────────────────────────────────
CREATE TABLE benchmark_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario        TEXT        NOT NULL,          -- ping | json | cpu | sleep-io | db-read | … | chat-gemini | cold-start | scale-out | rollout-disruption
    layer           TEXT        NOT NULL,          -- L1 | L2 | L3 | L4 | static | k8s
    platform        TEXT        NOT NULL,          -- compose | k8s (denormalised for filtering)
    config          JSONB       NOT NULL,          -- {concurrency, duration_s, warmup_s, reps, targets, py_profile, mode, …}
    status          run_status  NOT NULL DEFAULT 'queued',
    environment_id  UUID        REFERENCES environments(id),
    suspect         BOOLEAN     NOT NULL DEFAULT false,
    suspect_reasons TEXT[]      NOT NULL DEFAULT '{}',
    notes           TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX benchmark_runs_scenario_created_idx ON benchmark_runs (scenario, platform, created_at DESC);
-- Only one active run at a time (FR-12 / 409 busy)
CREATE UNIQUE INDEX benchmark_runs_one_active
    ON benchmark_runs ((true)) WHERE status IN ('queued','preflight','running','analyzing');

-- One row per (run, target, repetition)
CREATE TABLE run_results (
    id              BIGSERIAL PRIMARY KEY,
    run_id          UUID        NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    target          target_impl NOT NULL,
    rep             SMALLINT    NOT NULL,
    order_in_rep    SMALLINT    NOT NULL,          -- 1 = ran first, 2 = ran second
    requests_total  BIGINT      NOT NULL,
    errors_total    BIGINT      NOT NULL,
    status_counts   JSONB       NOT NULL,          -- {"200": 123, "429": 2}
    duration_s      DOUBLE PRECISION NOT NULL,
    rps             DOUBLE PRECISION NOT NULL,
    lat_p50_ms      DOUBLE PRECISION, lat_p90_ms DOUBLE PRECISION,
    lat_p95_ms      DOUBLE PRECISION, lat_p99_ms DOUBLE PRECISION,
    lat_max_ms      DOUBLE PRECISION, lat_mean_ms DOUBLE PRECISION,
    ttft_p50_ms     DOUBLE PRECISION, ttft_p99_ms DOUBLE PRECISION,      -- chat scenarios
    overhead_p50_ms DOUBLE PRECISION, overhead_p99_ms DOUBLE PRECISION,  -- chat scenarios
    cpu_avg_pct     DOUBLE PRECISION, cpu_max_pct DOUBLE PRECISION,
    cpu_throttled_pct DOUBLE PRECISION,           -- from bench_cgroup_cpu_throttled_seconds_total
    max_replicas    SMALLINT,                      -- scale-out (k8s)
    rollout_errors  BIGINT,                        -- rollout-disruption (k8s)
    mem_avg_mb      DOUBLE PRECISION, mem_max_mb  DOUBLE PRECISION,
    rps_per_core    DOUBLE PRECISION,
    rps_per_100mb   DOUBLE PRECISION,
    latency_histogram JSONB,                       -- HDR-style buckets [{le_ms, count}]
    raw_summary     JSONB,                         -- oha json / node runner summary verbatim
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, target, rep)
);

-- Time series during a run (1 Hz)
CREATE TABLE run_samples (
    run_id      UUID        NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    target      target_impl NOT NULL,
    rep         SMALLINT    NOT NULL,
    t_offset_s  INTEGER     NOT NULL,             -- seconds since this target's run start
    rps         DOUBLE PRECISION,
    lat_p50_ms  DOUBLE PRECISION,
    lat_p99_ms  DOUBLE PRECISION,
    errors      INTEGER,
    cpu_pct     DOUBLE PRECISION,
    mem_mb      DOUBLE PRECISION,
    threads     INTEGER,                          -- goroutines / threads
    db_pool_in_use INTEGER,
    replicas    SMALLINT,                         -- k8s: ready pods for this target at this second
    PRIMARY KEY (run_id, target, rep, t_offset_s)
);

-- Static characteristics (cold start, image size, idle mem) & DX notes
CREATE TABLE static_measurements (
    id           BIGSERIAL PRIMARY KEY,
    target       target_impl NOT NULL,
    metric       TEXT        NOT NULL,            -- cold_start_ms | pod_ready_ms | image_size_mb | idle_mem_mb | dep_count | build_time_s | loc
    platform     TEXT        NOT NULL,            -- compose | k8s
    value        DOUBLE PRECISION NOT NULL,
    environment_id UUID REFERENCES environments(id),
    measured_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dx_notes (
    target      target_impl PRIMARY KEY,
    markdown    TEXT        NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO dx_notes (target) VALUES ('go'), ('python');
```

`gen_random_uuid()` is built in from PG13+, so no extension is needed.

### 3.1 Useful views

```sql
-- Median across reps per run/target (what the UI headlines use)
CREATE VIEW run_summary AS
SELECT run_id, target,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY rps)          AS rps_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY lat_p99_ms)   AS p99_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY mem_avg_mb)   AS mem_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY overhead_p50_ms) AS overhead_p50_median,
       (stddev_pop(rps) / NULLIF(avg(rps),0)) * 100              AS rps_cv_pct
FROM run_results GROUP BY run_id, target;
```

---

## 4. ER overview

```
dashboard DB
 conversations 1──* chat_turns
 environments  1──* benchmark_runs 1──* run_results
                                   1──* run_samples
 environments  1──* static_measurements
 dx_notes (2 rows)

go_app / py_app DB (identical)
 app.bench_items      (100k seeded, read-only)
 app.bench_writes     (append; truncated by dashboard before db-write runs)
 app.rag_documents 1──* app.rag_chunks   (RAG knowledge base: vectors + FTS)
 public.<ADK session tables>  (owned by ADK; never queried directly)
```

## 5. Data lifecycle

- Before each `db-write` run, the dashboard runs `TRUNCATE app.bench_writes` on both app DBs through its own direct connections, so table size doesn't drift between targets.
- Chat-mock load runs create many ADK sessions. Afterwards the dashboard calls `DELETE /v1/sessions/{id}` for the sessions it created, or offers "Purge bench sessions" in `/about`.
- `make reset-db` wipes the Compose volume, and `make k8s-reset-db` deletes the k8s PVC. Init scripts re-run on the next boot. The Compose and k8s databases are **separate** (Docker volume vs local-path PVC), but they're seeded identically. Benchmark history lives in whichever `dashboard` DB was active. Use the dashboard's export/import (JSON) to merge history across modes.
- Migrations after v1: add numbered files `db/migrations/NNN_*.sql`, applied by the dashboard at startup with a `schema_migrations` table. Init scripts stay frozen at v1.
