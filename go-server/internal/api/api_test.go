package api

import (
	"bytes"
	"context"
	"encoding/json"
	"iter"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/genai"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/lalala0095/go-benchmarking/go-server/internal/agent"
	"github.com/lalala0095/go-benchmarking/go-server/internal/config"
	"github.com/lalala0095/go-benchmarking/go-server/internal/instrument"
	"github.com/lalala0095/go-benchmarking/go-server/internal/metrics"
	"github.com/lalala0095/go-benchmarking/go-server/internal/mockllm"
	"github.com/lalala0095/go-benchmarking/go-server/internal/rag"
)

var fast = mockllm.Config{FirstTokenDelay: 40 * time.Millisecond, TokenDelay: 3 * time.Millisecond, Tokens: 20}

type sseEvent struct {
	Name string
	Data map[string]any
}

func parseSSE(t *testing.T, body string) []sseEvent {
	t.Helper()
	var out []sseEvent
	for _, frame := range strings.Split(strings.TrimSpace(body), "\n\n") {
		lines := strings.Split(frame, "\n")
		if len(lines) != 2 || !strings.HasPrefix(lines[0], "event: ") || !strings.HasPrefix(lines[1], "data: ") {
			t.Fatalf("bad frame %q", frame)
		}
		var d map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(lines[1], "data: ")), &d); err != nil {
			t.Fatalf("bad data: %v", err)
		}
		out = append(out, sseEvent{strings.TrimPrefix(lines[0], "event: "), d})
	}
	return out
}

func fakeInventoryTool(t *testing.T) tool.Tool {
	tl, err := functiontool.New(functiontool.Config{Name: agent.ToolInventory, Description: "inv"},
		func(ctx adkagent.Context, a struct {
			Category string `json:"category"`
		}) (map[string]any, error) {
			time.Sleep(5 * time.Millisecond)
			return map[string]any{"category": a.Category, "count": 10000, "avg_price": 500.37, "min_price": 1.0, "max_price": 999.99}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	return tl
}

func newRunner(t *testing.T, m model.LLM, sessions session.Service) *runner.Runner {
	a, err := llmagent.New(llmagent.Config{
		Name: agent.AppName, Model: instrument.WrapModel(m), Instruction: "test",
		GenerateContentConfig: &genai.GenerateContentConfig{MaxOutputTokens: 512},
		Tools:                 []tool.Tool{fakeInventoryTool(t)},
		BeforeToolCallbacks:   []llmagent.BeforeToolCallback{agent.BeforeTool},
		AfterToolCallbacks:    []llmagent.AfterToolCallback{agent.AfterTool},
	})
	if err != nil {
		t.Fatal(err)
	}
	rn, err := runner.New(runner.Config{AppName: agent.AppName, Agent: a, SessionService: sessions})
	if err != nil {
		t.Fatal(err)
	}
	return rn
}

func newTestServer(t *testing.T, m model.LLM) (*Server, http.Handler) {
	sessions := instrument.WrapSessions(session.InMemoryService())
	s := &Server{
		Cfg:      &config.Config{GeminiModel: "gemini-x", DBPoolMax: 10},
		Sessions: sessions,
		Runners:  &agent.Runners{Mock: newRunner(t, m, sessions), MockModel: mockllm.Name, GeminiModel: "gemini-x"},
		Metrics:  metrics.New(nil, t.TempDir()),
	}
	return s, s.Handler()
}

func do(h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, rd))
	return rec
}

func createSession(t *testing.T, h http.Handler) string {
	rec := do(h, "POST", "/v1/sessions", map[string]string{"user_id": "u1"})
	if rec.Code != 201 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	var s map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &s)
	return s["session_id"].(string)
}

func TestSSEWriterFormat(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewSSEWriter(rec)
	_ = w.Event("token", map[string]any{"text": "a<b>\n", "seq": 1})
	if got := rec.Body.String(); got != "event: token\ndata: {\"seq\":1,\"text\":\"a<b>\\n\"}\n\n" {
		t.Fatalf("got %q", got)
	}
	if rec.Header().Get("Content-Type") != "text/event-stream" || !rec.Flushed {
		t.Fatal("headers/flush")
	}
}

func TestChatStreamPlain(t *testing.T) {
	_, h := newTestServer(t, mockllm.New(fast))
	sid := createSession(t, h)
	rec := do(h, "POST", "/v1/chat/stream", map[string]any{"user_id": "u1", "session_id": sid, "message": "hello world", "mode": "mock", "request_id": "r1"})
	evs := parseSSE(t, rec.Body.String())
	if evs[0].Name != "meta" || evs[0].Data["impl"] != "go" || evs[0].Data["request_id"] != "r1" || evs[0].Data["model"] != mockllm.Name {
		t.Fatalf("meta %+v", evs[0])
	}
	last := evs[len(evs)-1]
	if last.Name != "done" {
		t.Fatalf("last event %s %+v", last.Name, last.Data)
	}
	tokens := evs[1 : len(evs)-1]
	if len(tokens) != fast.Tokens {
		t.Fatalf("got %d tokens", len(tokens))
	}
	for i, e := range tokens {
		if e.Name != "token" || int(e.Data["seq"].(float64)) != i+1 {
			t.Fatalf("token %d: %+v", i, e)
		}
	}
	tm := last.Data["timings"].(map[string]any)
	model := tm["model_ms"].(float64)
	want := float64(fast.FirstTokenDelay.Milliseconds() + int64(fast.Tokens)*fast.TokenDelay.Milliseconds())
	if model < want*0.95 || model > want*1.5+20 {
		t.Fatalf("model_ms %v want ~%v", model, want)
	}
	total, ft := tm["server_total_ms"].(float64), tm["first_token_ms"].(float64)
	if ft <= 0 || ft > total || tm["session_ms"].(float64) <= 0 {
		t.Fatalf("timings %+v", tm)
	}
	sum := model + tm["tool_ms"].(float64) + tm["session_ms"].(float64) + tm["overhead_ms"].(float64)
	if d := sum - total; d > 0.01 || d < -0.01 {
		t.Fatalf("timings don't add up: %+v", tm)
	}
	u := last.Data["usage"].(map[string]any)
	if u["input_tokens"].(float64) != 2 || u["output_tokens"].(float64) != float64(fast.Tokens) {
		t.Fatalf("usage %+v", u)
	}
	if !strings.HasPrefix(last.Data["reply"].(string), "lorem ipsum") {
		t.Fatalf("reply %q", last.Data["reply"])
	}

	// History now has a user and a model event.
	rec = do(h, "GET", "/v1/sessions/"+sid+"?user_id=u1", nil)
	var hist struct {
		Events []HistoryEvent `json:"events"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &hist)
	if len(hist.Events) != 2 || hist.Events[0].Role != "user" || hist.Events[0].Text != "hello world" || hist.Events[1].Role != "model" {
		t.Fatalf("history %+v", hist.Events)
	}
}

func TestChatStreamInventoryTool(t *testing.T) {
	_, h := newTestServer(t, mockllm.New(fast))
	sid := createSession(t, h)
	rec := do(h, "POST", "/v1/chat/stream", map[string]any{"user_id": "u1", "session_id": sid, "message": "inventory please"})
	evs := parseSSE(t, rec.Body.String())
	names := []string{}
	for _, e := range evs {
		names = append(names, e.Name)
	}
	if evs[0].Name != "meta" || evs[1].Name != "tool_call" || evs[2].Name != "token" || evs[len(evs)-1].Name != "done" {
		t.Fatalf("order %v", names)
	}
	tc := evs[1].Data
	if tc["name"] != agent.ToolInventory || tc["args"].(map[string]any)["category"] != "electronics" || tc["duration_ms"].(float64) < 5 {
		t.Fatalf("tool_call %+v", tc)
	}
	if tc["result_summary"].(map[string]any)["count"].(float64) != 10000 {
		t.Fatalf("result_summary %+v", tc["result_summary"])
	}
	if evs[2].Data["text"] != "Electronics: 10000 items, avg price 500.37. " {
		t.Fatalf("prefix %q", evs[2].Data["text"])
	}
	tm := evs[len(evs)-1].Data["timings"].(map[string]any)
	want := float64(2*fast.FirstTokenDelay.Milliseconds() + int64(fast.Tokens)*fast.TokenDelay.Milliseconds())
	if m := tm["model_ms"].(float64); m < want*0.95 || m > want*1.5+20 {
		t.Fatalf("model_ms %v want ~%v", m, want)
	}
	if tm["tool_ms"].(float64) < 5 {
		t.Fatalf("tool_ms %+v", tm)
	}
	if u := evs[len(evs)-1].Data["usage"].(map[string]any); u["output_tokens"].(float64) != float64(fast.Tokens+1) {
		t.Fatalf("usage %+v", u)
	}

	// Non-streaming variant.
	rec = do(h, "POST", "/v1/chat", map[string]any{"user_id": "u1", "session_id": sid, "message": "inventory again"})
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Server-Timing"), "model;dur=") {
		t.Fatalf("chat: %d %s", rec.Code, rec.Body)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp["tool_calls"].([]any)) != 1 || !strings.HasPrefix(resp["reply"].(string), "Electronics: 10000") {
		t.Fatalf("resp %+v", resp)
	}
}

func TestChatValidationAndErrors(t *testing.T) {
	_, h := newTestServer(t, mockllm.New(fast))
	sid := createSession(t, h)
	cases := []struct {
		body   map[string]any
		status int
		code   string
	}{
		{map[string]any{"user_id": "u1", "session_id": sid}, 400, CodeBadRequest},
		{map[string]any{"user_id": "u1", "session_id": sid, "message": "x", "mode": "nope"}, 400, CodeBadRequest},
		{map[string]any{"user_id": "u1", "session_id": "missing", "message": "x"}, 404, CodeSessionNotFound},
		{map[string]any{"user_id": "u1", "session_id": sid, "message": "x", "mode": "gemini"}, 502, CodeUpstreamError},
	}
	for _, c := range cases {
		rec := do(h, "POST", "/v1/chat", c.body)
		var e APIError
		_ = json.Unmarshal(rec.Body.Bytes(), &e)
		if rec.Code != c.status || e.Code != c.code {
			t.Errorf("%v: got %d %s", c.body, rec.Code, rec.Body)
		}
	}
	// Stream: session not found is JSON 404 before streaming.
	rec := do(h, "POST", "/v1/chat/stream", map[string]any{"user_id": "u1", "session_id": "missing", "message": "x"})
	if rec.Code != 404 || !strings.Contains(rec.Header().Get("Content-Type"), "json") {
		t.Fatalf("stream 404: %d", rec.Code)
	}
	// Stream gemini without key: meta then error.
	rec = do(h, "POST", "/v1/chat/stream", map[string]any{"user_id": "u1", "session_id": sid, "message": "x", "mode": "gemini"})
	evs := parseSSE(t, rec.Body.String())
	if len(evs) != 2 || evs[0].Name != "meta" || evs[1].Name != "error" || evs[1].Data["code"] != CodeUpstreamError {
		t.Fatalf("got %+v", evs)
	}
}

type errModel struct{ err error }

func (e *errModel) Name() string { return "err" }
func (e *errModel) GenerateContent(context.Context, *model.LLMRequest, bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) { yield(nil, e.err) }
}

func TestUpstream429Classification(t *testing.T) {
	_, h := newTestServer(t, &errModel{err: genai.APIError{Code: 429, Message: "quota", Status: "RESOURCE_EXHAUSTED"}})
	sid := createSession(t, h)
	rec := do(h, "POST", "/v1/chat/stream", map[string]any{"user_id": "u1", "session_id": sid, "message": "hi"})
	evs := parseSSE(t, rec.Body.String())
	if last := evs[len(evs)-1]; last.Name != "error" || last.Data["code"] != CodeUpstream429 {
		t.Fatalf("got %+v", evs)
	}
	_, h = newTestServer(t, &errModel{err: genai.APIError{Code: 500, Message: "boom"}})
	sid = createSession(t, h)
	rec = do(h, "POST", "/v1/chat", map[string]any{"user_id": "u1", "session_id": sid, "message": "hi"})
	if rec.Code != 502 || !strings.Contains(rec.Body.String(), CodeUpstreamError) {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}

func TestSessionsEndpoints(t *testing.T) {
	_, h := newTestServer(t, mockllm.New(fast))
	if rec := do(h, "POST", "/v1/sessions", map[string]any{}); rec.Code != 400 {
		t.Fatalf("missing user_id: %d", rec.Code)
	}
	sid := createSession(t, h)
	if rec := do(h, "GET", "/v1/sessions/"+sid, nil); rec.Code != 400 {
		t.Fatalf("missing user_id query: %d", rec.Code)
	}
	rec := do(h, "GET", "/v1/sessions/"+sid+"?user_id=u1", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"events":[]`) || rec.Header().Get("Server-Timing") == "" {
		t.Fatalf("get: %d %s", rec.Code, rec.Body)
	}
	if rec := do(h, "DELETE", "/v1/sessions/"+sid+"?user_id=u1", nil); rec.Code != 204 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := do(h, "DELETE", "/v1/sessions/"+sid+"?user_id=u1", nil); rec.Code != 404 {
		t.Fatalf("delete again: %d", rec.Code)
	}
}

func TestBenchHandlersNoDB(t *testing.T) {
	_, h := newTestServer(t, mockllm.New(fast))
	if rec := do(h, "GET", "/bench/ping", nil); rec.Body.String() != `{"ok":true}` {
		t.Fatal(rec.Body.String())
	}
	if rec := do(h, "GET", "/bench/cpu?n=0", nil); rec.Code != 400 {
		t.Fatal(rec.Code)
	}
	rec := do(h, "GET", "/bench/sleep?ms=20", nil)
	if rec.Code != 200 || rec.Body.String() != `{"slept_ms":20}` || !strings.HasPrefix(rec.Header().Get("Server-Timing"), "total;dur=") {
		t.Fatal(rec.Body.String())
	}
	if rec := do(h, "POST", "/v1/rag/chunk", map[string]any{"content": "# T\n\nhello"}); !strings.Contains(rec.Body.String(), `"heading":"T"`) {
		t.Fatal(rec.Body.String())
	}
}

func TestInfo(t *testing.T) {
	_, h := newTestServer(t, mockllm.New(fast))
	rec := do(h, "GET", "/v1/info", nil)
	var info map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &info)
	for _, k := range []string{"impl", "runtime", "adk_version", "framework", "workers", "gomaxprocs", "model", "embed_model", "started_at", "cgroup_cpu_limit", "cgroup_memory_limit_bytes", "gemini_configured", "db_pool_max"} {
		if _, ok := info[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
}

func TestMapEvent(t *testing.T) {
	ts := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	ev := &session.Event{Timestamp: ts, Author: "bench_agent"}
	ev.Content = &genai.Content{Role: "model", Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{Name: "get_current_time"}}}}
	if he := MapEvent(ev); he.Role != "tool" || he.Tool != "get_current_time" || he.TS != "2026-01-02T03:04:05Z" {
		t.Fatalf("%+v", he)
	}
	ev.Content = &genai.Content{Role: "user", Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{Name: "x"}}}}
	if he := MapEvent(ev); he.Role != "tool" || he.Tool != "x" {
		t.Fatalf("%+v", he)
	}
	ev.Content = genai.NewContentFromText("hi", "model")
	if he := MapEvent(ev); he.Role != "model" || he.Text != "hi" {
		t.Fatalf("%+v", he)
	}
}

func TestMetricsRouteLabels(t *testing.T) {
	_, h := newTestServer(t, mockllm.New(fast))
	do(h, "GET", "/bench/ping", nil)
	sid := createSession(t, h)
	do(h, "GET", "/v1/sessions/"+sid+"?user_id=u1", nil)
	body := do(h, "GET", "/metrics", nil).Body.String()
	for _, want := range []string{`route="/bench/ping",status="200"`, `route="/v1/sessions/{session_id}",status="200"`, `route="/v1/sessions",status="201"`} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %s", want)
		}
	}
}

func TestValidationRejects(t *testing.T) {
	s, h := newTestServer(t, mockllm.New(fast))
	s.RAG = &rag.Service{Mock: &rag.MockEmbedder{}}
	for _, q := range []string{"k=0", "k=21", "k=x", "mode=bogus", "embedder=bogus"} {
		if rec := do(h, "GET", "/v1/rag/search?q=hi&"+q, nil); rec.Code != 400 {
			t.Errorf("%s: %d %s", q, rec.Code, rec.Body)
		}
	}
	for _, b := range []map[string]any{
		{}, {"corpus": "default", "repeat": 0}, {"corpus": "default", "repeat": 101},
		{"documents": []any{map[string]any{"source": "a.md"}}},
		{"documents": []any{map[string]any{"content": "x"}}},
	} {
		if rec := do(h, "POST", "/v1/rag/ingest", b); rec.Code != 400 {
			t.Errorf("%v: %d %s", b, rec.Code, rec.Body)
		}
	}
}

func TestCanceledRequestIs499(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()
	writeError(rec, httptest.NewRequest("GET", "/", nil).WithContext(ctx), 500, CodeInternal, "context canceled", "")
	if rec.Code != 499 {
		t.Fatal(rec.Code)
	}
}
