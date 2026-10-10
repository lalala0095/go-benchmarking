// Package agent builds the bench_agent LLM agents (Gemini and mock) and their
// ADK runners, sharing one session service (contracts/agent-spec.md).
package agent

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/genai"

	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/model/gemini"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"

	"github.com/lalala0095/go-benchmarking/go-server/internal/config"
	"github.com/lalala0095/go-benchmarking/go-server/internal/instrument"
	"github.com/lalala0095/go-benchmarking/go-server/internal/mockllm"
	"github.com/lalala0095/go-benchmarking/go-server/internal/rag"
)

// AppName is the ADK app name (and agent name).
const AppName = "bench_agent"

// Modes.
const (
	ModeGemini = "gemini"
	ModeMock   = "mock"
)

// Runners holds one runner per chat mode.
type Runners struct {
	Mock        *runner.Runner
	Gemini      *runner.Runner // nil when GOOGLE_API_KEY is not set
	MockModel   string
	GeminiModel string
}

// For returns the runner and model name for a mode.
func (r *Runners) For(mode string) (*runner.Runner, string) {
	if mode == ModeGemini {
		return r.Gemini, r.GeminiModel
	}
	return r.Mock, r.MockModel
}

// LoadInstruction reads the shared instruction file.
func LoadInstruction(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read instruction: %w", err)
	}
	return string(b), nil
}

// NewAgentRunner builds one bench_agent + runner around a model.
func NewAgentRunner(m model.LLM, instruction string, pool *pgxpool.Pool, rs *rag.Service, choose EmbedderChooser, sessions session.Service) (*runner.Runner, error) {
	tools, err := NewTools(pool, rs, choose)
	if err != nil {
		return nil, err
	}
	a, err := llmagent.New(llmagent.Config{
		Name:                  AppName,
		Description:           "Concise assistant for the Go vs FastAPI ADK benchmark project.",
		Model:                 instrument.WrapModel(m),
		Instruction:           instruction,
		GenerateContentConfig: &genai.GenerateContentConfig{MaxOutputTokens: 512},
		Tools:                 tools,
		BeforeToolCallbacks:   []llmagent.BeforeToolCallback{BeforeTool},
		AfterToolCallbacks:    []llmagent.AfterToolCallback{AfterTool},
	})
	if err != nil {
		return nil, err
	}
	return runner.New(runner.Config{AppName: AppName, Agent: a, SessionService: sessions})
}

// Build creates the mock runner and, if a key is configured, the Gemini one.
// sessions must already be the instrumented (timed) session service.
func Build(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, rs *rag.Service, sessions session.Service) (*Runners, error) {
	instruction, err := LoadInstruction(cfg.InstructionPath())
	if err != nil {
		return nil, err
	}
	out := &Runners{MockModel: mockllm.Name, GeminiModel: cfg.GeminiModel}

	mock := mockllm.New(mockllm.Config{
		FirstTokenDelay: cfg.MockFirstTokenDelay,
		TokenDelay:      cfg.MockTokenDelay,
		Tokens:          cfg.MockTokens,
	})
	mockChoose := func(context.Context) (string, time.Duration) { return rag.EmbedderMock, 0 }
	if out.Mock, err = NewAgentRunner(mock, instruction, pool, rs, mockChoose, sessions); err != nil {
		return nil, fmt.Errorf("mock runner: %w", err)
	}

	if cfg.GeminiConfigured() {
		gm, err := gemini.NewModel(ctx, cfg.GeminiModel, &genai.ClientConfig{APIKey: cfg.GoogleAPIKey, Backend: genai.BackendGeminiAPI})
		if err != nil {
			return nil, fmt.Errorf("gemini model: %w", err)
		}
		if out.Gemini, err = NewAgentRunner(gm, instruction, pool, rs, GeminiChooser(rs), sessions); err != nil {
			return nil, fmt.Errorf("gemini runner: %w", err)
		}
	}
	return out, nil
}

// GeminiChooser uses the gemini embedder, falling back to mock when no chunk
// has a Gemini embedding (or the embedder is unavailable).
func GeminiChooser(rs *rag.Service) EmbedderChooser {
	return func(ctx context.Context) (string, time.Duration) {
		if rs.Gemini == nil {
			return rag.EmbedderMock, 0
		}
		t0 := time.Now()
		ok, err := rs.Store.HasGeminiEmbeddings(ctx)
		el := time.Since(t0)
		if err != nil || !ok {
			return rag.EmbedderMock, el
		}
		return rag.EmbedderGemini, el
	}
}
