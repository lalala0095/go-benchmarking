-- Shared vector-only RAG search (docs/09-RAG.md §6). $1 = query vector, $2 = query text (unused), $3 = k
SELECT c.id, d.source, d.title, c.heading, c.content,
       (1 - (c.{{EMB_COL}} <=> $1::vector))::float8 AS score
FROM app.rag_chunks c
JOIN app.rag_documents d ON d.id = c.document_id
WHERE c.{{EMB_COL}} IS NOT NULL AND length($2::text) >= 0
ORDER BY c.{{EMB_COL}} <=> $1::vector  -- distance only, so the HNSW index is used
LIMIT $3::int
