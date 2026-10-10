package rag

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pgvector/pgvector-go"
)

// Search modes.
const (
	ModeHybrid = "hybrid"
	ModeVector = "vector"
	ModeFTS    = "fts"
)

var sqlFiles = map[string]string{
	ModeHybrid: "rag_search_hybrid.sql",
	ModeVector: "rag_search_vector.sql",
	ModeFTS:    "rag_search_fts.sql",
}

// embColumns is the fixed whitelist for the {{EMB_COL}} token.
var embColumns = map[string]string{
	EmbedderGemini: "embedding_gemini",
	EmbedderMock:   "embedding_mock",
}

// Statements holds the 6 search statements (3 modes x 2 embedding columns).
type Statements map[string]string // name -> SQL

// StmtName is the prepared-statement name for a mode/embedder pair.
func StmtName(mode, embedder string) string { return "rag_" + mode + "_" + embedder }

// LoadStatements reads the shared SQL files and expands {{EMB_COL}}.
func LoadStatements(sqlDir string) (Statements, error) {
	out := Statements{}
	for mode, file := range sqlFiles {
		raw, err := os.ReadFile(filepath.Join(sqlDir, file))
		if err != nil {
			return nil, fmt.Errorf("load %s: %w", file, err)
		}
		for emb, col := range embColumns {
			out[StmtName(mode, emb)] = strings.ReplaceAll(string(raw), "{{EMB_COL}}", col)
		}
	}
	return out, nil
}

// Prepare prepares all statements on a connection (used in pgxpool AfterConnect).
func (s Statements) Prepare(ctx context.Context, conn *pgx.Conn) error {
	for name, sql := range s {
		if _, err := conn.Prepare(ctx, name, sql); err != nil {
			return fmt.Errorf("prepare %s: %w", name, err)
		}
	}
	return nil
}

// Result is one search hit.
type Result struct {
	Source  string  `json:"source"`
	Title   string  `json:"title"`
	Heading string  `json:"heading"`
	Content string  `json:"content"`
	Score   float64 `json:"score"`
}

// Store runs queries against app.rag_* tables.
type Store struct {
	Pool *pgxpool.Pool
}

// Search runs one of the prepared search statements.
func (s *Store) Search(ctx context.Context, mode, embedder string, vec []float32, q string, k int) ([]Result, error) {
	if _, ok := sqlFiles[mode]; !ok {
		return nil, fmt.Errorf("unknown mode %q", mode)
	}
	if _, ok := embColumns[embedder]; !ok {
		return nil, fmt.Errorf("unknown embedder %q", embedder)
	}
	rows, err := s.Pool.Query(ctx, StmtName(mode, embedder), pgvector.NewVector(vec), q, k)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := []Result{}
	for rows.Next() {
		var id int64
		var r Result
		if err := rows.Scan(&id, &r.Source, &r.Title, &r.Heading, &r.Content, &r.Score); err != nil {
			return nil, err
		}
		results = append(results, r)
	}
	return results, rows.Err()
}

// Stats is the /v1/rag/stats payload.
type Stats struct {
	Documents            int64      `json:"documents"`
	Chunks               int64      `json:"chunks"`
	Chars                int64      `json:"chars"`
	GeminiEmbeddedChunks int64      `json:"gemini_embedded_chunks"`
	LastIngestedAt       *time.Time `json:"last_ingested_at"`
}

// Stats returns knowledge-base statistics.
func (s *Store) Stats(ctx context.Context) (*Stats, error) {
	var st Stats
	err := s.Pool.QueryRow(ctx, `SELECT
  (SELECT count(*) FROM app.rag_documents),
  (SELECT count(*) FROM app.rag_chunks),
  (SELECT coalesce(sum(char_count), 0)::bigint FROM app.rag_documents),
  (SELECT count(*) FROM app.rag_chunks WHERE embedding_gemini IS NOT NULL),
  (SELECT max(ingested_at) FROM app.rag_documents)`).
		Scan(&st.Documents, &st.Chunks, &st.Chars, &st.GeminiEmbeddedChunks, &st.LastIngestedAt)
	if err != nil {
		return nil, err
	}
	if st.LastIngestedAt != nil {
		t := st.LastIngestedAt.UTC()
		st.LastIngestedAt = &t
	}
	return &st, nil
}

// HasGeminiEmbeddings reports whether any chunk has a Gemini embedding.
func (s *Store) HasGeminiEmbeddings(ctx context.Context) (bool, error) {
	var ok bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM app.rag_chunks WHERE embedding_gemini IS NOT NULL)`).Scan(&ok)
	return ok, err
}

// Truncate wipes the knowledge base.
func (s *Store) Truncate(ctx context.Context) error {
	_, err := s.Pool.Exec(ctx, `TRUNCATE app.rag_documents CASCADE`)
	return err
}
