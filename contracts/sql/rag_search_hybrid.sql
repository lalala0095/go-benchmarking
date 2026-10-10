-- Shared hybrid RAG search (docs/09-RAG.md §6). Loaded verbatim by both servers.
-- {{EMB_COL}} is replaced with embedding_gemini | embedding_mock (whitelist only).
-- $1 = query vector (vector(768)), $2 = query text, $3 = k
WITH q AS (
  SELECT $1::vector AS emb,
         replace(plainto_tsquery('english', $2::text)::text, ' & ', ' | ')::tsquery AS tsq
),
vec AS (
  SELECT id, row_number() OVER (ORDER BY dist, id) AS r
  FROM (SELECT c.id, c.{{EMB_COL}} <=> q.emb AS dist
        FROM app.rag_chunks c, q
        WHERE c.{{EMB_COL}} IS NOT NULL
        ORDER BY c.{{EMB_COL}} <=> q.emb
        LIMIT 40) s
),
fts AS (
  SELECT id, row_number() OVER (ORDER BY rank DESC, id) AS r
  FROM (SELECT c.id, ts_rank_cd(c.tsv, q.tsq) AS rank
        FROM app.rag_chunks c, q
        WHERE numnode(q.tsq) > 0 AND c.tsv @@ q.tsq
        ORDER BY rank DESC, c.id
        LIMIT 40) s
),
fused AS (
  SELECT id, sum(1.0 / (60 + r))::float8 AS score
  FROM (SELECT id, r FROM vec UNION ALL SELECT id, r FROM fts) u
  GROUP BY id
)
SELECT c.id, d.source, d.title, c.heading, c.content, f.score
FROM fused f
JOIN app.rag_chunks c    ON c.id = f.id
JOIN app.rag_documents d ON d.id = c.document_id
ORDER BY f.score DESC, c.id
LIMIT $3::int
