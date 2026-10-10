// Package mockllm implements ADK-Go's model.LLM interface with the scripted
// mock described in contracts/agent-spec.md ("Mock LLM").
package mockllm

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"strconv"
	"strings"
	"time"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/model"
)

// Name is the mock model's name.
const Name = "mock"

// WORDS is the fixed lorem vocabulary.
var WORDS = []string{"lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore", "magna", "aliqua"}

// Config holds the mock timings.
type Config struct {
	FirstTokenDelay time.Duration
	TokenDelay      time.Duration
	Tokens          int
}

// Model is the mock LLM.
type Model struct{ cfg Config }

// New creates the mock model.
func New(cfg Config) *Model { return &Model{cfg: cfg} }

var _ model.LLM = (*Model)(nil)

// Name implements model.LLM.
func (m *Model) Name() string { return Name }

// sleepUntil waits until deadline (fixed deadlines avoid timer drift).
func sleepUntil(ctx context.Context, deadline time.Time) error {
	return sleep(ctx, time.Until(deadline))
}

// sleep is a context-aware wait.
func sleep(ctx context.Context, d time.Duration) error {
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

// GenerateContent implements model.LLM. In streaming mode it yields partial
// text chunks followed by a final aggregated (non-partial) response; without
// streaming it yields only the final response (after the same delays).
func (m *Model) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		var last *genai.Content
		if n := len(req.Contents); n > 0 {
			last = req.Contents[n-1]
		}
		userText := lastUserText(req.Contents)

		if fr := functionResponse(last); fr != nil {
			// Second call: the last content is a function response.
			m.streamText(ctx, prefixFor(fr), userText, stream, yield)
			return
		}

		lower := strings.ToLower(userText)
		switch {
		case strings.Contains(lower, "inventory"):
			m.functionCall(ctx, "get_inventory_stats", map[string]any{"category": "electronics"}, yield)
		case strings.Contains(lower, "docs") || strings.Contains(lower, "knowledge"):
			m.functionCall(ctx, "search_knowledge_base", map[string]any{"query": userText, "top_k": 5}, yield)
		default:
			m.streamText(ctx, "", userText, stream, yield)
		}
	}
}

func (m *Model) functionCall(ctx context.Context, name string, args map[string]any, yield func(*model.LLMResponse, error) bool) {
	if err := sleepUntil(ctx, time.Now().Add(m.cfg.FirstTokenDelay)); err != nil {
		yield(nil, err)
		return
	}
	yield(&model.LLMResponse{
		Content: &genai.Content{
			Role:  genai.RoleModel,
			Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{Name: name, Args: args}}},
		},
		TurnComplete: true,
		FinishReason: genai.FinishReasonStop,
	}, nil)
}

// streamText emits the text answer. Waits are scheduled against fixed
// deadlines from the start of the call: prefix at start+FIRST, chunk i at
// start+FIRST+(i+1)*TOKEN.
func (m *Model) streamText(ctx context.Context, prefix, userText string, stream bool, yield func(*model.LLMResponse, error) bool) {
	first := time.Now().Add(m.cfg.FirstTokenDelay)
	if err := sleepUntil(ctx, first); err != nil {
		yield(nil, err)
		return
	}
	var full strings.Builder
	emit := func(text string) bool {
		full.WriteString(text)
		if !stream {
			return true
		}
		return yield(&model.LLMResponse{
			Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{Text: text}}},
			Partial: true,
		}, nil)
	}
	outTokens := m.cfg.Tokens
	if prefix != "" {
		outTokens++
		if !emit(prefix) {
			return
		}
	}
	for i := 0; i < m.cfg.Tokens; i++ {
		if err := sleepUntil(ctx, first.Add(time.Duration(i+1)*m.cfg.TokenDelay)); err != nil {
			yield(nil, err)
			return
		}
		if !emit(WORDS[i%len(WORDS)] + " ") {
			return
		}
	}
	in := int32(len(strings.Fields(userText)))
	yield(&model.LLMResponse{
		Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{{Text: full.String()}}},
		UsageMetadata: &genai.GenerateContentResponseUsageMetadata{
			PromptTokenCount:     in,
			CandidatesTokenCount: int32(outTokens),
			TotalTokenCount:      in + int32(outTokens),
		},
		TurnComplete: true,
		FinishReason: genai.FinishReasonStop,
	}, nil)
}

// lastUserText returns the text of the most recent user content that has text.
func lastUserText(contents []*genai.Content) string {
	for i := len(contents) - 1; i >= 0; i-- {
		c := contents[i]
		if c == nil || c.Role != genai.RoleUser {
			continue
		}
		var sb strings.Builder
		for _, p := range c.Parts {
			if p != nil && p.Text != "" && !p.Thought {
				sb.WriteString(p.Text)
			}
		}
		if sb.Len() > 0 {
			return sb.String()
		}
	}
	return ""
}

func functionResponse(c *genai.Content) *genai.FunctionResponse {
	if c == nil {
		return nil
	}
	for _, p := range c.Parts {
		if p != nil && p.FunctionResponse != nil {
			return p.FunctionResponse
		}
	}
	return nil
}

func prefixFor(fr *genai.FunctionResponse) string {
	switch fr.Name {
	case "get_inventory_stats":
		var r struct {
			Count    float64 `json:"count"`
			AvgPrice float64 `json:"avg_price"`
		}
		remarshal(fr.Response, &r)
		return fmt.Sprintf("Electronics: %s items, avg price %s. ", strconv.FormatInt(int64(r.Count), 10), pyFloat(r.AvgPrice))
	case "search_knowledge_base":
		var r struct {
			Results []struct {
				Source string `json:"source"`
			} `json:"results"`
		}
		remarshal(fr.Response, &r)
		if len(r.Results) == 0 {
			return "Based on [no results]: "
		}
		return "Based on [" + r.Results[0].Source + "]: "
	}
	return ""
}

func remarshal(in any, out any) {
	b, err := json.Marshal(in)
	if err == nil {
		_ = json.Unmarshal(b, out)
	}
}

// pyFloat formats a float like Python's str(float): 500.4 -> "500.4",
// 500.0 -> "500.0".
func pyFloat(v float64) string {
	s := strconv.FormatFloat(v, 'f', -1, 64)
	if !strings.ContainsAny(s, ".eEnN") {
		s += ".0"
	}
	return s
}
