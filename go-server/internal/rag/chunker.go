// Package rag implements the shared RAG pipeline (docs/09-RAG.md): chunking,
// embedding, ingestion and hybrid retrieval. The chunker and mock embedder are
// byte-for-byte ports of contracts/tools/reference.py.
package rag

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode/utf8"
)

const (
	// MaxChunk is the maximum chunk length in Unicode code points.
	MaxChunk = 1200
	// EmbedDim is the embedding dimensionality for both embedders.
	EmbedDim = 768
	// ws is the ASCII whitespace set used for every trim/split.
	ws = " \t\n\v\f\r"
)

// Chunk is one chunk of a document.
type Chunk struct {
	ChunkIndex int    `json:"chunk_index"`
	Heading    string `json:"heading"`
	Content    string `json:"content"`
}

// Normalize strips a UTF-8 BOM and normalises line endings to "\n".
func Normalize(text string) string {
	text = strings.TrimPrefix(text, "\uFEFF")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	return strings.ReplaceAll(text, "\r", "\n")
}

// ContentHash is the sha256 hex of the normalised text.
func ContentHash(text string) string {
	sum := sha256.Sum256([]byte(Normalize(text)))
	return hex.EncodeToString(sum[:])
}

// TitleOf returns the first "# " heading, or filename if there is none.
func TitleOf(text, filename string) string {
	for _, line := range strings.Split(Normalize(text), "\n") {
		if strings.HasPrefix(line, "# ") {
			return strings.Trim(line[2:], ws)
		}
	}
	return filename
}

// EmbedInput is the text that gets embedded for a chunk.
func EmbedInput(heading, content string) string {
	if heading != "" {
		return heading + "\n\n" + content
	}
	return content
}

// isHeading reports whether line matches ^#{1,6} .
func isHeading(line string) bool {
	n := 0
	for n < len(line) && n < 6 && line[n] == '#' {
		n++
	}
	return n >= 1 && n < len(line) && line[n] == ' '
}

func isBlank(line string) bool { return strings.Trim(line, ws) == "" }

func runeLen(s string) int { return utf8.RuneCountInString(s) }

type section struct {
	heading string
	lines   []string
}

func sections(text string) []section {
	var out []section
	heading, lines, inFence := "", []string{}, false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "```") {
			inFence = !inFence
			lines = append(lines, line)
			continue
		}
		if !inFence && isHeading(line) {
			out = append(out, section{heading, lines})
			heading = strings.Trim(strings.TrimLeft(line, "#"), ws)
			lines = []string{}
			continue
		}
		lines = append(lines, line)
	}
	return append(out, section{heading, lines})
}

func paragraphs(lines []string) []string {
	var paras, cur []string
	inFence := false
	for _, line := range lines {
		fence := strings.HasPrefix(line, "```")
		if fence {
			inFence = !inFence
		}
		if !inFence && !fence && isBlank(line) {
			if len(cur) > 0 {
				paras = append(paras, strings.Join(cur, "\n"))
				cur = nil
			}
			continue
		}
		cur = append(cur, line)
	}
	if len(cur) > 0 {
		paras = append(paras, strings.Join(cur, "\n"))
	}
	out := make([]string, 0, len(paras))
	for _, p := range paras {
		if p = strings.Trim(p, ws); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func isWS(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\v', '\f', '\r':
		return true
	}
	return false
}

func splitLong(p string) []string {
	var words []string
	for _, w := range strings.FieldsFunc(p, isWS) {
		rs := []rune(w)
		for len(rs) > MaxChunk {
			words = append(words, string(rs[:MaxChunk]))
			rs = rs[MaxChunk:]
		}
		if len(rs) > 0 {
			words = append(words, string(rs))
		}
	}
	var pieces []string
	cur, curLen := "", 0
	for _, w := range words {
		wl := runeLen(w)
		switch {
		case cur == "":
			cur, curLen = w, wl
		case curLen+1+wl <= MaxChunk:
			cur += " " + w
			curLen += 1 + wl
		default:
			pieces = append(pieces, cur)
			cur, curLen = w, wl
		}
	}
	if cur != "" {
		pieces = append(pieces, cur)
	}
	return pieces
}

// ChunkText splits a document into chunks (docs/09-RAG.md §2).
func ChunkText(text string) []Chunk {
	text = Normalize(text)
	chunks := []Chunk{}
	for _, sec := range sections(text) {
		var pieces []string
		for _, p := range paragraphs(sec.lines) {
			if runeLen(p) > MaxChunk {
				pieces = append(pieces, splitLong(p)...)
			} else {
				pieces = append(pieces, p)
			}
		}
		have, cur, curLen := false, "", 0
		for _, p := range pieces {
			pl := runeLen(p)
			switch {
			case !have:
				have, cur, curLen = true, p, pl
			case curLen+2+pl <= MaxChunk:
				cur += "\n\n" + p
				curLen += 2 + pl
			default:
				chunks = append(chunks, Chunk{ChunkIndex: len(chunks), Heading: sec.heading, Content: cur})
				cur, curLen = p, pl
			}
		}
		if have {
			chunks = append(chunks, Chunk{ChunkIndex: len(chunks), Heading: sec.heading, Content: cur})
		}
	}
	return chunks
}
