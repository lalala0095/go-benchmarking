package rag

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/pgvector/pgvector-go"
)

// Document is an input document for ingestion.
type Document struct {
	Source  string  `json:"source"`
	Title   string  `json:"title,omitempty"`
	Content *string `json:"content"`
}

// doc is a resolved document to ingest.
type doc struct{ Source, Title, Content string }

// IngestRequest is the /v1/rag/ingest body.
type IngestRequest struct {
	Corpus         string     `json:"corpus,omitempty"`
	IncludePrivate bool       `json:"include_private,omitempty"`
	Documents      []Document `json:"documents,omitempty"`
	Repeat         *int       `json:"repeat,omitempty"`
	Force          bool       `json:"force,omitempty"`
	Embedders      []string   `json:"embedders,omitempty"`
}

// IngestTimings are the ingest timings in milliseconds.
type IngestTimings struct {
	ReadMs        float64 `json:"read_ms"`
	ChunkMs       float64 `json:"chunk_ms"`
	EmbedMs       float64 `json:"embed_ms"`
	EmbedGeminiMs float64 `json:"embed_gemini_ms"`
	EmbedMockMs   float64 `json:"embed_mock_ms"`
	DBMs          float64 `json:"db_ms"`
	TotalMs       float64 `json:"total_ms"`
}

func (t *IngestTimings) round() {
	for _, p := range []*float64{&t.ReadMs, &t.ChunkMs, &t.EmbedMs, &t.EmbedGeminiMs, &t.EmbedMockMs, &t.DBMs, &t.TotalMs} {
		*p = round3(*p)
	}
}

// IngestResponse is the /v1/rag/ingest response.
type IngestResponse struct {
	Documents int           `json:"documents"`
	Skipped   int           `json:"skipped"`
	Chunks    int           `json:"chunks"`
	Chars     int           `json:"chars"`
	Embedders []string      `json:"embedders"`
	Timings   IngestTimings `json:"timings"`
}

// WalkCorpus lists .md/.txt files under dir (recursive, sorted by relative
// path, "/" separators), skipping private/ unless includePrivate.
func WalkCorpus(dir string, includePrivate bool) ([]string, error) {
	var out []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if !includePrivate && rel == "private" {
				return filepath.SkipDir
			}
			return nil
		}
		if ext := strings.ToLower(path.Ext(rel)); ext == ".md" || ext == ".txt" {
			out = append(out, rel)
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}

func (s *Service) resolveEmbedders(req []string) ([]string, error) {
	want := map[string]bool{EmbedderMock: true}
	if len(req) == 0 {
		if s.Gemini != nil {
			want[EmbedderGemini] = true
		}
	}
	for _, e := range req {
		switch e {
		case EmbedderMock:
		case EmbedderGemini:
			if s.Gemini == nil {
				return nil, ErrGeminiNotConfigured
			}
			want[EmbedderGemini] = true
		default:
			return nil, badRequest("unknown embedder %q", e)
		}
	}
	out := []string{}
	for _, e := range []string{EmbedderGemini, EmbedderMock} {
		if want[e] {
			out = append(out, e)
		}
	}
	return out, nil
}

// Ingest runs the ingestion pipeline (docs/09-RAG.md §5).
func (s *Service) Ingest(ctx context.Context, req *IngestRequest) (*IngestResponse, error) {
	start := time.Now()
	if req.Corpus == "" && len(req.Documents) == 0 {
		return nil, badRequest("corpus or documents is required")
	}
	if req.Corpus != "" && req.Corpus != "default" {
		return nil, badRequest("corpus must be \"default\"")
	}
	repeat := 1
	if req.Repeat != nil {
		repeat = *req.Repeat
	}
	if repeat < 1 || repeat > 100 {
		return nil, badRequest("repeat must be 1..100")
	}
	for _, d := range req.Documents {
		if d.Source == "" || d.Content == nil {
			return nil, badRequest("each document needs source and content")
		}
	}
	embedders, err := s.resolveEmbedders(req.Embedders)
	if err != nil {
		return nil, err
	}
	resp := &IngestResponse{Embedders: embedders}
	t := &resp.Timings

	// Read.
	r0 := time.Now()
	docs := []doc{}
	if req.Corpus != "" {
		files, err := WalkCorpus(s.CorpusDir, req.IncludePrivate)
		if err != nil {
			return nil, fmt.Errorf("walk corpus: %w", err)
		}
		for _, rel := range files {
			raw, err := os.ReadFile(filepath.Join(s.CorpusDir, filepath.FromSlash(rel)))
			if err != nil {
				return nil, fmt.Errorf("read %s: %w", rel, err)
			}
			docs = append(docs, doc{Source: rel, Content: string(raw)})
		}
	}
	for _, d := range req.Documents {
		docs = append(docs, doc{Source: d.Source, Title: d.Title, Content: *d.Content})
	}
	if repeat > 1 {
		base := docs
		docs = make([]doc, 0, len(base)*repeat)
		for i := 0; i < repeat; i++ {
			for _, d := range base {
				d.Source = fmt.Sprintf("r%d/%s", i, d.Source)
				docs = append(docs, d)
			}
		}
	}
	t.ReadMs = Ms(time.Since(r0))

	// Existing hashes, for skip detection.
	existing := map[string]string{}
	if !req.Force {
		d0 := time.Now()
		rows, err := s.Store.Pool.Query(ctx, `SELECT source, content_hash FROM app.rag_documents`)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var src, h string
			if err := rows.Scan(&src, &h); err != nil {
				rows.Close()
				return nil, err
			}
			existing[src] = h
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		t.DBMs += Ms(time.Since(d0))
	}

	for _, d := range docs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		hash := ContentHash(d.Content)
		if h, ok := existing[d.Source]; ok && h == hash && !req.Force {
			resp.Skipped++
			continue
		}
		c0 := time.Now()
		norm := Normalize(d.Content)
		chunks := ChunkText(norm)
		title := d.Title
		if title == "" {
			title = TitleOf(norm, path.Base(d.Source))
		}
		inputs := make([]string, len(chunks))
		for i, c := range chunks {
			inputs[i] = EmbedInput(c.Heading, c.Content)
		}
		t.ChunkMs += Ms(time.Since(c0))

		var mockVecs, gemVecs [][]float32
		var embedModel *string
		for _, name := range embedders {
			if len(inputs) == 0 {
				break
			}
			emb, err := s.Embedder(name)
			if err != nil {
				return nil, err
			}
			e0 := time.Now()
			vecs, err := emb.Embed(ctx, inputs, TaskDocument)
			el := Ms(time.Since(e0))
			if err != nil {
				return nil, fmt.Errorf("embed %s with %s: %w", d.Source, name, err)
			}
			t.EmbedMs += el
			if name == EmbedderGemini {
				t.EmbedGeminiMs += el
				gemVecs = vecs
				m := s.GeminiTag
				embedModel = &m
			} else {
				t.EmbedMockMs += el
				mockVecs = vecs
			}
		}

		d0 := time.Now()
		charCount := runeLen(norm)
		if err := s.writeDocument(ctx, d.Source, title, hash, charCount, chunks, mockVecs, gemVecs, embedModel); err != nil {
			return nil, fmt.Errorf("store %s: %w", d.Source, err)
		}
		t.DBMs += Ms(time.Since(d0))
		resp.Documents++
		resp.Chunks += len(chunks)
		resp.Chars += charCount
	}
	t.TotalMs = Ms(time.Since(start))
	t.round()
	return resp, nil
}

var copyColumns = []string{"document_id", "chunk_index", "heading", "content", "char_count", "embedding_gemini", "embedding_mock"}

// writeDocument upserts the document and replaces its chunks in one
// transaction, inserting chunks with COPY.
func (s *Service) writeDocument(ctx context.Context, source, title, hash string, chars int, chunks []Chunk, mock, gem [][]float32, embedModel *string) error {
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	var docID int64
	err = tx.QueryRow(ctx, `INSERT INTO app.rag_documents (source, title, content_hash, char_count, chunk_count, embed_model, ingested_at)
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT (source) DO UPDATE SET title = EXCLUDED.title, content_hash = EXCLUDED.content_hash,
  char_count = EXCLUDED.char_count, chunk_count = EXCLUDED.chunk_count, embed_model = EXCLUDED.embed_model,
  ingested_at = EXCLUDED.ingested_at
RETURNING id`, source, title, hash, chars, len(chunks), embedModel).Scan(&docID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM app.rag_chunks WHERE document_id = $1`, docID); err != nil {
		return err
	}
	if len(chunks) > 0 {
		rows := make([][]any, len(chunks))
		for i, c := range chunks {
			var g any
			if gem != nil {
				g = pgvector.NewVector(gem[i])
			}
			rows[i] = []any{docID, c.ChunkIndex, c.Heading, c.Content, runeLen(c.Content), g, pgvector.NewVector(mock[i])}
		}
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"app", "rag_chunks"}, copyColumns, pgx.CopyFromRows(rows)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
