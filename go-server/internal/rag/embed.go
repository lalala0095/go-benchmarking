package rag

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"google.golang.org/genai"
)

// Task selects the embedding task type.
type Task string

const (
	TaskDocument Task = "document"
	TaskQuery    Task = "query"
)

// Embedder names.
const (
	EmbedderMock   = "mock"
	EmbedderGemini = "gemini"
)

// Embedder turns texts into 768-dim L2-normalised vectors.
type Embedder interface {
	Name() string
	Embed(ctx context.Context, texts []string, task Task) ([][]float32, error)
}

// ErrGeminiNotConfigured is returned when the Gemini embedder is requested
// without GOOGLE_API_KEY.
var ErrGeminiNotConfigured = errors.New("GOOGLE_API_KEY not configured")

// ---------------------------------------------------------------------------
// Mock embedder (docs/09-RAG.md §3, normative)

// MockEmbedder is the deterministic hashing-trick embedder. It sleeps Delay
// once per batch of BatchSize texts to simulate network latency.
type MockEmbedder struct {
	Delay     time.Duration
	BatchSize int
}

func (m *MockEmbedder) Name() string { return EmbedderMock }

// Embed implements Embedder.
func (m *MockEmbedder) Embed(ctx context.Context, texts []string, _ Task) ([][]float32, error) {
	out := make([][]float32, 0, len(texts))
	bs := max(m.BatchSize, 1)
	for start := 0; start < len(texts); start += bs {
		if err := Sleep(ctx, m.Delay); err != nil {
			return nil, err
		}
		for _, t := range texts[start:min(start+bs, len(texts))] {
			out = append(out, MockEmbed(t))
		}
	}
	return out, nil
}

// MockEmbed computes the mock embedding of a single text.
func MockEmbed(text string) []float32 {
	var v [EmbedDim]float64
	i := 0
	for i < len(text) {
		if !isAlnum(text[i]) {
			i++
			continue
		}
		// FNV-1a 32-bit over the ASCII-lowercased token bytes.
		h := uint32(2166136261)
		for ; i < len(text) && isAlnum(text[i]); i++ {
			b := text[i]
			if b >= 'A' && b <= 'Z' {
				b += 'a' - 'A'
			}
			h ^= uint32(b)
			h *= 16777619
		}
		if h>>31 == 0 {
			v[h%EmbedDim] += 1
		} else {
			v[h%EmbedDim] -= 1
		}
	}
	return normalize64(v[:])
}

func isAlnum(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

func normalize64(v []float64) []float32 {
	var sum float64
	for _, x := range v {
		sum += x * x
	}
	out := make([]float32, len(v))
	norm := math.Sqrt(sum)
	if norm == 0 {
		return out
	}
	for i, x := range v {
		out[i] = float32(x / norm)
	}
	return out
}

// L2Normalize normalises a float32 vector (accumulating in float64).
func L2Normalize(v []float32) []float32 {
	f := make([]float64, len(v))
	for i, x := range v {
		f[i] = float64(x)
	}
	return normalize64(f)
}

// Sleep waits d or until ctx is done.
func Sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ---------------------------------------------------------------------------
// Gemini embedder

// GeminiEmbedder embeds via the Gemini API (batchEmbedContents).
type GeminiEmbedder struct {
	Client    *genai.Client
	Model     string
	BatchSize int
	// Backoff base for 429/5xx retries (default 1s); MaxTries default 5.
	BackoffBase time.Duration
	MaxTries    int
	// TaskType: "" sends no task type (default for gemini-embedding-2);
	// "retrieval" sends RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY per task; any
	// other value is sent verbatim. From GEMINI_EMBED_TASK_TYPE.
	TaskType string
}

// NewGeminiEmbedder creates a Gemini embedder for the given API key.
func NewGeminiEmbedder(ctx context.Context, apiKey, model string, batch int, httpOpts *genai.HTTPOptions) (*GeminiEmbedder, error) {
	cfg := &genai.ClientConfig{APIKey: apiKey, Backend: genai.BackendGeminiAPI}
	if httpOpts != nil {
		cfg.HTTPOptions = *httpOpts
	}
	client, err := genai.NewClient(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &GeminiEmbedder{Client: client, Model: model, BatchSize: batch, BackoffBase: time.Second, MaxTries: 5}, nil
}

func (g *GeminiEmbedder) Name() string { return EmbedderGemini }

// Embed implements Embedder.
func (g *GeminiEmbedder) Embed(ctx context.Context, texts []string, task Task) ([][]float32, error) {
	dim := int32(EmbedDim)
	cfg := &genai.EmbedContentConfig{TaskType: g.taskType(task), OutputDimensionality: &dim}
	bs := max(g.BatchSize, 1)
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += bs {
		batch := texts[start:min(start+bs, len(texts))]
		contents := make([]*genai.Content, len(batch))
		for i, t := range batch {
			contents[i] = genai.NewContentFromText(t, genai.RoleUser)
		}
		resp, err := g.embedWithRetry(ctx, contents, cfg)
		if err != nil {
			return nil, err
		}
		if len(resp.Embeddings) != len(batch) {
			return nil, fmt.Errorf("gemini embed: got %d embeddings for %d texts", len(resp.Embeddings), len(batch))
		}
		for _, e := range resp.Embeddings {
			if e == nil || len(e.Values) != EmbedDim {
				return nil, fmt.Errorf("gemini embed: unexpected embedding dimension")
			}
			out = append(out, L2Normalize(e.Values))
		}
	}
	return out, nil
}

func (g *GeminiEmbedder) taskType(task Task) string {
	switch strings.ToLower(g.TaskType) {
	case "":
		return ""
	case "retrieval", "true", "1":
		if task == TaskQuery {
			return "RETRIEVAL_QUERY"
		}
		return "RETRIEVAL_DOCUMENT"
	}
	return g.TaskType
}

func (g *GeminiEmbedder) embedWithRetry(ctx context.Context, contents []*genai.Content, cfg *genai.EmbedContentConfig) (*genai.EmbedContentResponse, error) {
	tries := g.MaxTries
	if tries <= 0 {
		tries = 5
	}
	backoff := g.BackoffBase
	if backoff <= 0 {
		backoff = time.Second
	}
	var lastErr error
	for attempt := 0; attempt < tries; attempt++ {
		if attempt > 0 {
			if err := Sleep(ctx, backoff); err != nil {
				return nil, err
			}
			backoff *= 2
		}
		resp, err := g.Client.Models.EmbedContent(ctx, g.Model, contents, cfg)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if !Retryable(err) {
			return nil, err
		}
	}
	return nil, lastErr
}

// Retryable reports whether a Gemini API error is a 429 or 5xx.
func Retryable(err error) bool {
	var apiErr genai.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Code == http.StatusTooManyRequests || apiErr.Code >= 500
	}
	var apiErrP *genai.APIError
	if errors.As(err, &apiErrP) {
		return apiErrP.Code == http.StatusTooManyRequests || apiErrP.Code >= 500
	}
	return false
}
