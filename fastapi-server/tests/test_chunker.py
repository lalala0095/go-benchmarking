import json

import pytest

from app.rag.chunker import chunk, content_hash, title_of
from tests.conftest import CONTRACTS

CASES = sorted((CONTRACTS / "fixtures" / "rag-chunking" / "cases").glob("*"))


@pytest.mark.parametrize("case", CASES, ids=lambda p: p.name)
def test_chunker_matches_fixture_bytes(case):
    expected_path = CONTRACTS / "fixtures" / "rag-chunking" / "expected" / (case.name + ".json")
    text = case.read_bytes().decode("utf-8")
    out = {
        "source": case.name,
        "title": title_of(text, case.name),
        "content_hash": content_hash(text),
        "chunks": chunk(text),
    }
    got = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    assert got.encode("utf-8") == expected_path.read_bytes()


def test_all_cases_have_expected():
    assert len(CASES) >= 12


def test_large_fixture_chunks_within_limit():
    text = (CONTRACTS / "fixtures" / "rag-chunking" / "large.md").read_text(encoding="utf-8")
    chunks = chunk(text)
    assert chunks and all(len(c["content"]) <= 1200 for c in chunks)
    assert [c["chunk_index"] for c in chunks] == list(range(len(chunks)))
