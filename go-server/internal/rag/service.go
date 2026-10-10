package rag

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"time"
)

// ErrBadRequest marks client errors from the service.
var ErrBadRequest = errors.New("bad request")

func badRequest(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrBadRequest, fmt.Sprintf(format, args...))
}

// Service wires the store and embedders.
type Service struct {
	Store     *Store
	Mock      Embedder
	Gemini    Embedder // nil when GOOGLE_API_KEY is not set
	GeminiTag string   // embed model name stored in rag_documents.embed_model
	CorpusDir string
	Presets   []string
}

// LoadPresets reads contracts/fixtures/rag-queries.json.
func LoadPresets(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var qs []string
	if err := json.Unmarshal(raw, &qs); err != nil {
		return nil, err
	}
	return qs, nil
}

// RandomPreset picks a random preset query.
func (s *Service) RandomPreset() (string, bool) {
	if len(s.Presets) == 0 {
		return "", false
	}
	return s.Presets[rand.IntN(len(s.Presets))], true
}

// Embedder returns the embedder by name.
func (s *Service) Embedder(name string) (Embedder, error) {
	switch name {
	case EmbedderMock:
		return s.Mock, nil
	case EmbedderGemini:
		if s.Gemini == nil {
			return nil, ErrGeminiNotConfigured
		}
		return s.Gemini, nil
	}
	return nil, badRequest("unknown embedder %q", name)
}

// SearchTimings are the per-search timings in milliseconds.
type SearchTimings struct {
	EmbedMs float64 `json:"embed_ms"`
	DBMs    float64 `json:"db_ms"`
	TotalMs float64 `json:"total_ms"`
}

// Ms converts a duration to float milliseconds.
func Ms(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e6 }

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// Search embeds the query (except for fts, whose $1 is unused) and runs the
// shared SQL.
func (s *Service) Search(ctx context.Context, query string, k int, mode, embedder string) ([]Result, SearchTimings, error) {
	start := time.Now()
	var t SearchTimings
	if _, ok := sqlFiles[mode]; !ok {
		return nil, t, badRequest("mode must be hybrid, vector or fts")
	}
	emb, err := s.Embedder(embedder)
	if err != nil {
		return nil, t, err
	}
	var vec []float32
	if mode == ModeFTS {
		vec = make([]float32, EmbedDim)
	} else {
		e0 := time.Now()
		vs, err := emb.Embed(ctx, []string{query}, TaskQuery)
		if err != nil {
			return nil, t, fmt.Errorf("embed query: %w", err)
		}
		vec = vs[0]
		t.EmbedMs = Ms(time.Since(e0))
	}
	d0 := time.Now()
	res, err := s.Store.Search(ctx, mode, embedder, vec, query, k)
	t.DBMs = Ms(time.Since(d0))
	t.TotalMs = Ms(time.Since(start))
	t.EmbedMs, t.DBMs, t.TotalMs = round3(t.EmbedMs), round3(t.DBMs), round3(t.TotalMs)
	return res, t, err
}
