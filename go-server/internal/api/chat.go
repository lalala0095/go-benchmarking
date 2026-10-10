package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/genai"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"

	"github.com/lalala0095/go-benchmarking/go-server/internal/agent"
	"github.com/lalala0095/go-benchmarking/go-server/internal/instrument"
)

// ChatRequest is the /v1/chat[/stream] body.
type ChatRequest struct {
	UserID    string `json:"user_id"`
	SessionID string `json:"session_id"`
	Message   string `json:"message"`
	Mode      string `json:"mode"`
	RequestID string `json:"request_id"`
}

// Usage is the token usage object.
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// ToolCallEvent is the tool_call SSE payload (and /v1/chat tool_calls item).
type ToolCallEvent struct {
	Name          string         `json:"name"`
	Args          map[string]any `json:"args"`
	DurationMs    float64        `json:"duration_ms"`
	ResultSummary map[string]any `json:"result_summary"`
	EmbedMs       *float64       `json:"embed_ms,omitempty"`
	DBMs          *float64       `json:"db_ms,omitempty"`
}

// chatSink receives streaming output from runChat.
type chatSink interface {
	Token(text string, seq int) error
	ToolCall(tc ToolCallEvent) error
}

// chatError is a classified chat failure.
type chatError struct {
	Status  int
	Code    string
	Message string
}

func (e *chatError) Error() string { return e.Message }

// validateChat parses and validates the request (before any streaming).
func (s *Server) validateChat(w http.ResponseWriter, r *http.Request) (*ChatRequest, bool) {
	var req ChatRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid JSON body", "")
		return nil, false
	}
	if req.RequestID == "" {
		req.RequestID = uuid.NewString()
	}
	if req.Mode == "" {
		req.Mode = agent.ModeMock
	}
	n := utf8.RuneCountInString(req.Message)
	switch {
	case req.UserID == "" || req.SessionID == "":
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "user_id and session_id are required", req.RequestID)
		return nil, false
	case n < 1 || n > 20000:
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "message must be 1..20000 characters", req.RequestID)
		return nil, false
	case req.Mode != agent.ModeMock && req.Mode != agent.ModeGemini:
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "mode must be gemini or mock", req.RequestID)
		return nil, false
	}
	return &req, true
}

// checkSession verifies the session exists (timed into session_ms).
func (s *Server) checkSession(ctx context.Context, req *ChatRequest) error {
	_, err := s.Sessions.Get(ctx, &session.GetRequest{AppName: agent.AppName, UserID: req.UserID, SessionID: req.SessionID, NumRecentEvents: 1})
	return err
}

// errGeminiNotConfigured is returned for gemini mode without a key.
var errGeminiNotConfigured = &chatError{Status: http.StatusBadGateway, Code: CodeUpstreamError, Message: "GOOGLE_API_KEY not configured"}

// classify maps a run error to a contract error.
func classify(err error, acc *instrument.Acc) *chatError {
	var ce *chatError
	if errors.As(err, &ce) {
		return ce
	}
	if errors.Is(err, session.ErrNotFound) {
		return &chatError{http.StatusNotFound, CodeSessionNotFound, "session not found"}
	}
	var me *instrument.ModelError
	modelErr := acc.ModelErr()
	if errors.As(err, &me) {
		modelErr = me.Err
	}
	if modelErr != nil {
		if apiCode(modelErr) == http.StatusTooManyRequests {
			return &chatError{http.StatusBadGateway, CodeUpstream429, modelErr.Error()}
		}
		return &chatError{http.StatusBadGateway, CodeUpstreamError, modelErr.Error()}
	}
	return &chatError{http.StatusInternalServerError, CodeInternal, err.Error()}
}

func apiCode(err error) int {
	var v genai.APIError
	if errors.As(err, &v) {
		return v.Code
	}
	var p *genai.APIError
	if errors.As(err, &p) {
		return p.Code
	}
	return 0
}

// toolEvent converts a finished tool record into the SSE payload.
func toolEvent(rec instrument.ToolRecord) ToolCallEvent {
	ev := ToolCallEvent{
		Name:       rec.Name,
		Args:       rec.Args,
		DurationMs: instrument.Round3(instrument.Ms(rec.Duration)),
		EmbedMs:    rec.EmbedMs,
		DBMs:       rec.DBMs,
	}
	if ev.Args == nil {
		ev.Args = map[string]any{}
	}
	switch {
	case rec.Err != nil:
		ev.ResultSummary = map[string]any{"error": rec.Err.Error()}
	case rec.Name == agent.ToolSearch:
		sources := []any{}
		if items, ok := rec.Result["results"].([]any); ok {
			for _, it := range items {
				if m, ok := it.(map[string]any); ok {
					sources = append(sources, m["source"])
				}
			}
		}
		ev.ResultSummary = map[string]any{"sources": sources}
	default:
		ev.ResultSummary = rec.Result
		if ev.ResultSummary == nil {
			ev.ResultSummary = map[string]any{}
		}
	}
	return ev
}

// runChat drives the ADK runner in SSE streaming mode and forwards partial
// text and finished tool calls to sink. It returns the full reply and usage.
func runChat(ctx context.Context, rn *runner.Runner, req *ChatRequest, sink chatSink) (string, Usage, error) {
	acc := instrument.From(ctx)
	msg := genai.NewContentFromText(req.Message, genai.RoleUser)
	var reply strings.Builder
	var usage Usage
	seq := 0
	emitTool := func(rec instrument.ToolRecord) error { return sink.ToolCall(toolEvent(rec)) }

	for ev, err := range rn.Run(ctx, req.UserID, req.SessionID, msg, adkagent.RunConfig{StreamingMode: adkagent.StreamingModeSSE}) {
		if err != nil {
			return reply.String(), usage, err
		}
		if ev == nil || ev.Author == "user" {
			continue
		}
		if ev.Partial {
			if t := textOf(ev.Content); t != "" {
				seq++
				if err := sink.Token(t, seq); err != nil {
					return reply.String(), usage, err
				}
				acc.MarkFirstToken()
			}
			continue
		}
		if c := ev.Content; c != nil {
			for _, p := range c.Parts {
				if p != nil && p.FunctionResponse != nil {
					if rec, ok := acc.TakeTool(p.FunctionResponse.ID); ok {
						if err := emitTool(rec); err != nil {
							return reply.String(), usage, err
						}
					}
				}
			}
			reply.WriteString(textOf(c))
		}
		if u := ev.UsageMetadata; u != nil {
			usage.InputTokens += int(u.PromptTokenCount)
			usage.OutputTokens += int(u.CandidatesTokenCount)
		}
	}
	for _, rec := range acc.TakeRemainingTools() {
		if err := emitTool(rec); err != nil {
			return reply.String(), usage, err
		}
	}
	if err := ctx.Err(); err != nil {
		return reply.String(), usage, err
	}
	return reply.String(), usage, nil
}

func textOf(c *genai.Content) string {
	if c == nil {
		return ""
	}
	var sb strings.Builder
	for _, p := range c.Parts {
		if p != nil && p.Text != "" && !p.Thought {
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

// ---------------------------------------------------------------------------
// Streaming

type sseSink struct{ w *SSEWriter }

func (s *sseSink) Token(text string, seq int) error {
	return s.w.Event("token", map[string]any{"text": text, "seq": seq})
}
func (s *sseSink) ToolCall(tc ToolCallEvent) error { return s.w.Event("tool_call", tc) }

func (s *Server) chatStream(w http.ResponseWriter, r *http.Request) {
	acc := instrument.New()
	acc.Start = requestStart(r)
	ctx := instrument.With(r.Context(), acc)

	req, ok := s.validateChat(w, r)
	if !ok {
		return
	}
	if err := s.checkSession(ctx, req); err != nil {
		ce := classify(err, acc)
		writeError(w, r, ce.Status, ce.Code, ce.Message, req.RequestID)
		return
	}
	rn, modelName := s.Runners.For(req.Mode)

	sse := NewSSEWriter(w)
	if err := sse.Event("meta", map[string]any{
		"request_id": req.RequestID, "impl": "go", "session_id": req.SessionID, "mode": req.Mode, "model": modelName,
	}); err != nil {
		return
	}
	writeErr := func(ce *chatError) {
		_ = sse.Event("error", map[string]any{"request_id": req.RequestID, "code": ce.Code, "message": ce.Message})
	}
	if rn == nil {
		writeErr(errGeminiNotConfigured)
		return
	}
	reply, usage, err := runChat(ctx, rn, req, &sseSink{w: sse})
	if err != nil {
		if r.Context().Err() == nil {
			writeErr(classify(err, acc))
		}
		return
	}
	timings := acc.Finish()
	_ = sse.Event("done", map[string]any{"request_id": req.RequestID, "reply": reply, "timings": timings, "usage": usage})
	s.observeChat(req.Mode, timings)
}

func (s *Server) observeChat(mode string, t instrument.Timings) {
	if s.Metrics != nil {
		s.Metrics.ObserveChat(mode, time.Duration(t.OverheadMs*1e6), time.Duration(t.ModelMs*1e6))
	}
}

// ---------------------------------------------------------------------------
// Non-streaming

type collectSink struct{ tools []ToolCallEvent }

func (c *collectSink) Token(string, int) error { return nil }
func (c *collectSink) ToolCall(tc ToolCallEvent) error {
	c.tools = append(c.tools, tc)
	return nil
}

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	acc := instrument.New()
	acc.Start = requestStart(r)
	ctx := instrument.With(r.Context(), acc)

	req, ok := s.validateChat(w, r)
	if !ok {
		return
	}
	if err := s.checkSession(ctx, req); err != nil {
		ce := classify(err, acc)
		writeError(w, r, ce.Status, ce.Code, ce.Message, req.RequestID)
		return
	}
	rn, _ := s.Runners.For(req.Mode)
	if rn == nil {
		ce := errGeminiNotConfigured
		writeError(w, r, ce.Status, ce.Code, ce.Message, req.RequestID)
		return
	}
	sink := &collectSink{tools: []ToolCallEvent{}}
	reply, usage, err := runChat(ctx, rn, req, sink)
	if err != nil {
		ce := classify(err, acc)
		writeError(w, r, ce.Status, ce.Code, ce.Message, req.RequestID)
		return
	}
	timings := acc.Finish()
	var dbMs float64
	for _, tc := range sink.tools {
		if tc.DBMs != nil {
			dbMs += *tc.DBMs
		}
	}
	s.observeChat(req.Mode, timings)
	writeJSON(w, r, http.StatusOK, map[string]any{
		"request_id": req.RequestID, "session_id": req.SessionID, "reply": reply,
		"tool_calls": sink.tools, "timings": timings, "usage": usage,
	}, timing{"model", timings.ModelMs}, timing{"tool", timings.ToolMs}, timing{"session", timings.SessionMs}, timing{"db", dbMs})
}
