package mockllm

import (
	"context"
	"strings"
	"testing"
	"time"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/model"
)

var fast = Config{FirstTokenDelay: 30 * time.Millisecond, TokenDelay: 2 * time.Millisecond, Tokens: 25}

func collect(t *testing.T, m *Model, req *model.LLMRequest, stream bool) []*model.LLMResponse {
	t.Helper()
	var out []*model.LLMResponse
	for r, err := range m.GenerateContent(context.Background(), req, stream) {
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func userReq(msg string) *model.LLMRequest {
	return &model.LLMRequest{Contents: []*genai.Content{genai.NewContentFromText(msg, genai.RoleUser)}}
}

func expectedText(prefix string, n int) string {
	var sb strings.Builder
	sb.WriteString(prefix)
	for i := 0; i < n; i++ {
		sb.WriteString(WORDS[i%len(WORDS)] + " ")
	}
	return sb.String()
}

func TestPlainBranchStreaming(t *testing.T) {
	m := New(fast)
	start := time.Now()
	out := collect(t, m, userReq("hello there world"), true)
	el := time.Since(start)
	if len(out) != fast.Tokens+1 {
		t.Fatalf("got %d responses, want %d partial + 1 final", len(out), fast.Tokens)
	}
	for i, r := range out[:fast.Tokens] {
		if !r.Partial || r.Content.Parts[0].Text != WORDS[i%len(WORDS)]+" " {
			t.Fatalf("chunk %d = %+v", i, r.Content.Parts[0].Text)
		}
	}
	final := out[len(out)-1]
	if final.Partial || final.Content.Parts[0].Text != expectedText("", fast.Tokens) {
		t.Fatalf("bad final: %q", final.Content.Parts[0].Text)
	}
	if u := final.UsageMetadata; u.PromptTokenCount != 3 || u.CandidatesTokenCount != int32(fast.Tokens) {
		t.Fatalf("usage %+v", u)
	}
	min := fast.FirstTokenDelay + time.Duration(fast.Tokens)*fast.TokenDelay
	if el < min {
		t.Fatalf("elapsed %v < %v", el, min)
	}
}

func TestPlainBranchNonStreaming(t *testing.T) {
	out := collect(t, New(fast), userReq("hi"), false)
	if len(out) != 1 || out[0].Partial || out[0].Content.Parts[0].Text != expectedText("", fast.Tokens) {
		t.Fatalf("got %d responses", len(out))
	}
}

func TestFunctionCallBranches(t *testing.T) {
	cases := []struct {
		msg, tool string
		args      map[string]any
	}{
		{"What's our INVENTORY like? also docs", "get_inventory_stats", map[string]any{"category": "electronics"}},
		{"Check the Docs please", "search_knowledge_base", map[string]any{"query": "Check the Docs please", "top_k": 5}},
		{"knowledge base?", "search_knowledge_base", map[string]any{"query": "knowledge base?", "top_k": 5}},
	}
	for _, c := range cases {
		out := collect(t, New(fast), userReq(c.msg), true)
		if len(out) != 1 || out[0].Partial {
			t.Fatalf("%q: want single final response, got %d", c.msg, len(out))
		}
		fc := out[0].Content.Parts[0].FunctionCall
		if fc == nil || fc.Name != c.tool {
			t.Fatalf("%q: got %+v", c.msg, fc)
		}
		for k, v := range c.args {
			if fc.Args[k] != v {
				t.Fatalf("%q: arg %s = %v want %v", c.msg, k, fc.Args[k], v)
			}
		}
	}
}

func secondReq(name string, resp map[string]any) *model.LLMRequest {
	return &model.LLMRequest{Contents: []*genai.Content{
		genai.NewContentFromText("tell me about inventory now", genai.RoleUser),
		{Role: genai.RoleModel, Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{Name: name}}}},
		{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{Name: name, Response: resp}}}},
	}}
}

func TestSecondCallPrefixes(t *testing.T) {
	cases := []struct {
		name   string
		resp   map[string]any
		prefix string
	}{
		{"get_inventory_stats", map[string]any{"count": float64(10000), "avg_price": 500.37}, "Electronics: 10000 items, avg price 500.37. "},
		{"get_inventory_stats", map[string]any{"count": 3, "avg_price": 12.0}, "Electronics: 3 items, avg price 12.0. "},
		{"search_knowledge_base", map[string]any{"results": []any{map[string]any{"source": "docs/a.md"}, map[string]any{"source": "b"}}}, "Based on [docs/a.md]: "},
		{"search_knowledge_base", map[string]any{"results": []any{}}, "Based on [no results]: "},
	}
	for _, c := range cases {
		out := collect(t, New(fast), secondReq(c.name, c.resp), true)
		if len(out) != fast.Tokens+2 {
			t.Fatalf("%s: got %d responses", c.name, len(out))
		}
		if !out[0].Partial || out[0].Content.Parts[0].Text != c.prefix {
			t.Fatalf("prefix = %q, want %q", out[0].Content.Parts[0].Text, c.prefix)
		}
		final := out[len(out)-1]
		if final.Content.Parts[0].Text != expectedText(c.prefix, fast.Tokens) {
			t.Fatalf("final text mismatch")
		}
		if final.UsageMetadata.CandidatesTokenCount != int32(fast.Tokens+1) || final.UsageMetadata.PromptTokenCount != 5 {
			t.Fatalf("usage %+v", final.UsageMetadata)
		}
	}
}

func TestContextCancellation(t *testing.T) {
	m := New(Config{FirstTokenDelay: 5 * time.Second, TokenDelay: time.Second, Tokens: 10})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	var gotErr error
	for _, err := range m.GenerateContent(ctx, userReq("hi"), true) {
		if err != nil {
			gotErr = err
		}
	}
	if gotErr == nil || time.Since(start) > time.Second {
		t.Fatalf("expected prompt cancellation, err=%v after %v", gotErr, time.Since(start))
	}
}
