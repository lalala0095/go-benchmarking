"""RAG operations shared by the HTTP API and the agent tool (docs/09-RAG.md §5–7)."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.config import Settings, get_settings
from app.db import get_pool
from app.errors import bad_request
from app.instrument import ms, now_ns
from app.rag import search as rag_search
from app.rag.chunker import chunk, content_hash, embed_input, normalize, title_of
from app.rag.embed import GeminiEmbedder, MockEmbedder

log = logging.getLogger(__name__)

_embedders: dict[str, object] = {}


def get_embedder(name: str):
    if name not in _embedders:
        s = get_settings()
        if name == "mock":
            _embedders[name] = MockEmbedder(s)
        elif name == "gemini":
            _embedders[name] = GeminiEmbedder(s)
        else:
            raise bad_request(f"unknown embedder {name!r}")
    return _embedders[name]


def reset_embedders() -> None:
    _embedders.clear()


# ── search ────────────────────────────────────────────────────────────────


_ZERO_VEC = [0.0] * 768


@dataclass
class SearchResult:
    rows: list
    embed_ns: int
    db_ns: int


async def search(query: str, k: int, mode: str, embedder: str) -> SearchResult:
    emb = get_embedder(embedder)
    t0 = now_ns()
    if mode == "fts":
        # $1 is accepted but unused by the fts statement (identical signatures), so
        # no embedding call is made.
        vec = _ZERO_VEC
    else:
        vec = (await emb.embed([query], task="query"))[0]
    embed_ns = now_ns() - t0
    async with get_pool().acquire() as conn:
        rows, db_ns = await rag_search.run_search(conn, mode, embedder, vec, query, k)
    return SearchResult(rows=rows, embed_ns=embed_ns, db_ns=db_ns)


async def stats() -> dict:
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT (SELECT count(*) FROM app.rag_documents)::int AS documents,
                   (SELECT count(*) FROM app.rag_chunks)::int AS chunks,
                   (SELECT coalesce(sum(char_count), 0) FROM app.rag_documents)::bigint AS chars,
                   (SELECT count(*) FROM app.rag_chunks WHERE embedding_gemini IS NOT NULL)::int
                       AS gemini_embedded_chunks,
                   (SELECT max(ingested_at) FROM app.rag_documents) AS last_ingested_at
            """
        )
    last = row["last_ingested_at"]
    return {
        "documents": row["documents"],
        "chunks": row["chunks"],
        "chars": int(row["chars"]),
        "gemini_embedded_chunks": row["gemini_embedded_chunks"],
        "last_ingested_at": last.isoformat().replace("+00:00", "Z") if last else None,
    }


async def wipe() -> None:
    async with get_pool().acquire() as conn:
        await conn.execute("TRUNCATE app.rag_documents CASCADE")


# ── ingest ────────────────────────────────────────────────────────────────


@dataclass
class Doc:
    source: str
    title: str
    text: str  # raw text as read


@dataclass
class IngestTimings:
    read_ns: int = 0
    chunk_ns: int = 0
    embed_gemini_ns: int = 0
    embed_mock_ns: int = 0
    db_ns: int = 0


def read_corpus(corpus_dir: Path, include_private: bool) -> list[Doc]:
    """Every .md/.txt under the corpus root, recursive, sorted by relative path."""
    found: list[tuple[str, Path]] = []
    if not corpus_dir.is_dir():
        return []
    for dirpath, dirnames, filenames in os.walk(corpus_dir, followlinks=True):
        rel_dir = Path(dirpath).relative_to(corpus_dir)
        if not include_private and rel_dir == Path("."):
            dirnames[:] = [d for d in dirnames if d != "private"]
        for fn in filenames:
            if fn.startswith(".") or not (fn.endswith(".md") or fn.endswith(".txt")):
                continue
            p = Path(dirpath) / fn
            found.append(((rel_dir / fn).as_posix(), p))
    found.sort(key=lambda x: x[0])
    docs: list[Doc] = []
    for rel, p in found:
        text = p.read_bytes().decode("utf-8")
        docs.append(Doc(source=rel, title=title_of(text, p.name), text=text))
    return docs


_UPSERT_DOC = """
INSERT INTO app.rag_documents (source, title, content_hash, char_count, chunk_count, embed_model, ingested_at)
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT (source) DO UPDATE
   SET title = EXCLUDED.title, content_hash = EXCLUDED.content_hash, char_count = EXCLUDED.char_count,
       chunk_count = EXCLUDED.chunk_count, embed_model = EXCLUDED.embed_model, ingested_at = now()
RETURNING id
"""

_CHUNK_COLUMNS = [
    "document_id",
    "chunk_index",
    "heading",
    "content",
    "char_count",
    "embedding_gemini",
    "embedding_mock",
]


def resolve_embedders(requested: Optional[list], settings: Settings) -> list[str]:
    if requested is None:
        return ["gemini", "mock"] if settings.gemini_configured else ["mock"]
    if not isinstance(requested, list) or any(e not in ("gemini", "mock") for e in requested):
        raise bad_request("embedders must be a subset of [gemini, mock]")
    out = []
    if "gemini" in requested:
        if not settings.gemini_configured:
            raise bad_request("embedder gemini requested but GOOGLE_API_KEY is not configured")
        out.append("gemini")
    out.append("mock")  # mock is always included
    return out


async def ingest(body: dict) -> dict:
    settings = get_settings()
    t_start = now_ns()
    corpus = body.get("corpus")
    documents = body.get("documents")
    include_private = bool(body.get("include_private", False))
    force = bool(body.get("force", False))
    repeat = body.get("repeat", 1)
    if corpus is None and documents is None:
        raise bad_request("either corpus or documents is required")
    if corpus is not None and corpus != "default":
        raise bad_request("corpus must be 'default'")
    if not isinstance(repeat, int) or isinstance(repeat, bool) or not 1 <= repeat <= 100:
        raise bad_request("repeat must be an integer in 1..100")
    embedders = resolve_embedders(body.get("embedders"), settings)

    tm = IngestTimings()
    t0 = now_ns()
    base: list[Doc] = []
    if corpus is not None:
        base.extend(read_corpus(settings.corpus_dir, include_private))
    if documents is not None:
        if not isinstance(documents, list):
            raise bad_request("documents must be an array")
        for d in documents:
            if not isinstance(d, dict) or not isinstance(d.get("source"), str) or not isinstance(d.get("content"), str):
                raise bad_request("each document needs string source and content")
            if not d["source"]:
                raise bad_request("document source must be non-empty")
            title = d.get("title")
            if not isinstance(title, str) or not title:
                title = title_of(d["content"], d["source"].rsplit("/", 1)[-1])
            base.append(Doc(source=d["source"], title=title, text=d["content"]))
    tm.read_ns = now_ns() - t0

    if repeat > 1:
        docs = [Doc(source=f"r{i}/{d.source}", title=d.title, text=d.text) for i in range(repeat) for d in base]
    else:
        docs = base

    pool = get_pool()
    existing: dict[str, str] = {}
    if not force and docs:
        t0 = now_ns()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT source, content_hash FROM app.rag_documents WHERE source = ANY($1::text[])",
                [d.source for d in docs],
            )
        tm.db_ns += now_ns() - t0
        existing = {r["source"]: r["content_hash"] for r in rows}

    n_docs = skipped = n_chunks = n_chars = 0
    gemini = get_embedder("gemini") if "gemini" in embedders else None
    mock = get_embedder("mock")
    for d in docs:
        h = content_hash(d.text)
        if not force and existing.get(d.source) == h:
            skipped += 1
            continue
        t0 = now_ns()
        chunks = chunk(d.text)
        char_count = len(normalize(d.text))
        inputs = [embed_input(c["heading"], c["content"]) for c in chunks]
        tm.chunk_ns += now_ns() - t0

        gem_vecs: list = [None] * len(chunks)
        if gemini is not None and inputs:
            t0 = now_ns()
            gem_vecs = await gemini.embed(inputs, task="document")
            tm.embed_gemini_ns += now_ns() - t0
        mock_vecs: list = []
        if inputs:
            t0 = now_ns()
            mock_vecs = await mock.embed(inputs, task="document")
            tm.embed_mock_ns += now_ns() - t0

        t0 = now_ns()
        async with pool.acquire() as conn:
            async with conn.transaction():
                doc_id = await conn.fetchval(
                    _UPSERT_DOC,
                    d.source,
                    d.title,
                    h,
                    char_count,
                    len(chunks),
                    settings.gemini_embed_model if gemini is not None else None,
                )
                await conn.execute("DELETE FROM app.rag_chunks WHERE document_id = $1", doc_id)
                if chunks:
                    records = [
                        (doc_id, c["chunk_index"], c["heading"], c["content"], len(c["content"]), gem_vecs[i], mock_vecs[i])
                        for i, c in enumerate(chunks)
                    ]
                    await conn.copy_records_to_table(
                        "rag_chunks", schema_name="app", columns=_CHUNK_COLUMNS, records=records
                    )
        tm.db_ns += now_ns() - t0
        n_docs += 1
        n_chunks += len(chunks)
        n_chars += char_count

    embed_ns = tm.embed_gemini_ns + tm.embed_mock_ns
    timings = {
        "read_ms": ms(tm.read_ns),
        "chunk_ms": ms(tm.chunk_ns),
        "embed_ms": ms(embed_ns),
        "embed_gemini_ms": ms(tm.embed_gemini_ns),
        "embed_mock_ms": ms(tm.embed_mock_ns),
        "db_ms": ms(tm.db_ns),
        "total_ms": ms(now_ns() - t_start),
    }
    return {
        "documents": n_docs,
        "skipped": skipped,
        "chunks": n_chunks,
        "chars": n_chars,
        "embedders": embedders,
        "timings": timings,
    }
