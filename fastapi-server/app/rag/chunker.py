"""Deterministic chunker — a direct port of contracts/tools/reference.py (docs/09-RAG.md §2).

The reference file is normative; keep this byte-for-byte equivalent.
"""

from __future__ import annotations

import hashlib
import re

MAX_CHUNK = 1200
WS = " \t\n\v\f\r"  # ASCII whitespace only
_HEADING = re.compile(r"^#{1,6} ")
_WS_RUN = re.compile(r"[ \t\n\v\f\r]+")


def normalize(text: str) -> str:
    if text.startswith("﻿"):
        text = text[1:]
    return text.replace("\r\n", "\n").replace("\r", "\n")


def content_hash(text: str) -> str:
    return hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


def _sections(text: str) -> list[tuple[str, list[str]]]:
    sections: list[tuple[str, list[str]]] = []
    heading, lines, in_fence = "", [], False
    for line in text.split("\n"):
        if line.startswith("```"):
            in_fence = not in_fence
            lines.append(line)
            continue
        if not in_fence and _HEADING.match(line):
            sections.append((heading, lines))
            heading = line.lstrip("#").strip(WS)
            lines = []
            continue
        lines.append(line)
    sections.append((heading, lines))
    return sections


def _paragraphs(lines: list[str]) -> list[str]:
    paras: list[str] = []
    cur: list[str] = []
    in_fence = False
    for line in lines:
        if line.startswith("```"):
            in_fence = not in_fence
        if not in_fence and line.strip(WS) == "" and not line.startswith("```"):
            if cur:
                paras.append("\n".join(cur))
                cur = []
            continue
        cur.append(line)
    if cur:
        paras.append("\n".join(cur))
    out = []
    for p in paras:
        p = p.strip(WS)
        if p:
            out.append(p)
    return out


def _split_long(p: str) -> list[str]:
    words: list[str] = []
    for w in _WS_RUN.split(p):
        if not w:
            continue
        while len(w) > MAX_CHUNK:
            words.append(w[:MAX_CHUNK])
            w = w[MAX_CHUNK:]
        if w:
            words.append(w)
    pieces: list[str] = []
    cur = ""
    for w in words:
        if cur == "":
            cur = w
        elif len(cur) + 1 + len(w) <= MAX_CHUNK:
            cur = cur + " " + w
        else:
            pieces.append(cur)
            cur = w
    if cur:
        pieces.append(cur)
    return pieces


def chunk(text: str) -> list[dict]:
    """Returns [{"chunk_index", "heading", "content"}] (key order matters for JSON parity)."""
    text = normalize(text)
    chunks: list[tuple[str, str]] = []
    for heading, lines in _sections(text):
        pieces: list[str] = []
        for p in _paragraphs(lines):
            if len(p) > MAX_CHUNK:
                pieces.extend(_split_long(p))
            else:
                pieces.append(p)
        cur = None
        for p in pieces:
            if cur is None:
                cur = p
            elif len(cur) + 2 + len(p) <= MAX_CHUNK:
                cur = cur + "\n\n" + p
            else:
                chunks.append((heading, cur))
                cur = p
        if cur is not None:
            chunks.append((heading, cur))
    return [{"chunk_index": i, "heading": h, "content": c} for i, (h, c) in enumerate(chunks)]


def embed_input(heading: str, content: str) -> str:
    return f"{heading}\n\n{content}" if heading else content


def title_of(text: str, filename: str) -> str:
    for line in normalize(text).split("\n"):
        if line.startswith("# "):
            return line[2:].strip(WS)
    return filename
