-- Shared full-text-only RAG search (docs/09-RAG.md §6). $1 = query vector (unused), $2 = query text, $3 = k
WITH q AS (
  SELECT replace(plainto_tsquery('english', $2::text)::text, ' & ', ' | ')::tsquery AS tsq,
         $1::vector AS unused
)
SELECT c.id, d.source, d.title, c.heading, c.content,
       ts_rank_cd(c.tsv, q.tsq)::float8 AS score
FROM app.rag_chunks c
JOIN app.rag_documents d ON d.id = c.document_id, q
WHERE numnode(q.tsq) > 0 AND c.tsv @@ q.tsq
ORDER BY score DESC, c.id
LIMIT $3::int
