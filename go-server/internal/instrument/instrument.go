// Package instrument holds the per-request timing accumulator and the
// decorators that feed it: a model.LLM wrapper (model_ms), a session.Service
// wrapper (session_ms) and tool callbacks (tool_ms, embed_ms, db_ms).
// All durations use Go's monotonic clock (time.Now/time.Since).
package instrument

import (
	"context"
	"math"
	"sync"
	"sync/atomic"
	"time"
)

type ctxKey struct{}

// ToolRecord is one finished (or running) tool call.
type ToolRecord struct {
	CallID   string
	Name     string
	Args     map[string]any
	Result   map[string]any
	Err      error
	Duration time.Duration
	EmbedMs  *float64
	DBMs     *float64
	Done     bool
	Emitted  bool

	start time.Time
}

// Acc accumulates timings for one request. Methods are nil-safe and
// goroutine-safe (ADK may run tools/model in other goroutines).
type Acc struct {
	Start time.Time

	modelNs   atomic.Int64
	toolNs    atomic.Int64
	sessionNs atomic.Int64

	mu         sync.Mutex
	firstToken time.Duration
	tools      map[string]*ToolRecord
	order      []string
	modelErr   error
}

// New creates an accumulator starting now.
func New() *Acc { return &Acc{Start: time.Now(), tools: map[string]*ToolRecord{}} }

// With attaches acc to ctx.
func With(ctx context.Context, acc *Acc) context.Context {
	return context.WithValue(ctx, ctxKey{}, acc)
}

// From returns the accumulator in ctx, or nil.
func From(ctx context.Context) *Acc {
	if ctx == nil {
		return nil
	}
	a, _ := ctx.Value(ctxKey{}).(*Acc)
	return a
}

// AddModel adds time spent awaiting the model.
func (a *Acc) AddModel(d time.Duration) {
	if a != nil {
		a.modelNs.Add(int64(d))
	}
}

// AddTool adds tool execution time.
func (a *Acc) AddTool(d time.Duration) {
	if a != nil {
		a.toolNs.Add(int64(d))
	}
}

// AddSession adds session-service time.
func (a *Acc) AddSession(d time.Duration) {
	if a != nil {
		a.sessionNs.Add(int64(d))
	}
}

// Model returns the accumulated model time.
func (a *Acc) Model() time.Duration { return time.Duration(a.modelNs.Load()) }

// Tool returns the accumulated tool time.
func (a *Acc) Tool() time.Duration { return time.Duration(a.toolNs.Load()) }

// Session returns the accumulated session time.
func (a *Acc) Session() time.Duration { return time.Duration(a.sessionNs.Load()) }

// MarkFirstToken records the first-token time (only the first call counts).
func (a *Acc) MarkFirstToken() {
	if a == nil {
		return
	}
	a.mu.Lock()
	if a.firstToken == 0 {
		a.firstToken = max(time.Since(a.Start), 1)
	}
	a.mu.Unlock()
}

// SetModelErr remembers the last model error (for error classification).
func (a *Acc) SetModelErr(err error) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.modelErr = err
	a.mu.Unlock()
}

// ModelErr returns the last model error.
func (a *Acc) ModelErr() error {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.modelErr
}

// ToolStart records the start of a tool call.
func (a *Acc) ToolStart(callID, name string, args map[string]any) {
	if a == nil {
		return
	}
	cp := make(map[string]any, len(args))
	for k, v := range args {
		cp[k] = v
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.tools[callID]; !ok {
		a.order = append(a.order, callID)
	}
	a.tools[callID] = &ToolRecord{CallID: callID, Name: name, Args: cp, start: time.Now()}
}

// ToolExtra records embed/db timings reported by a tool implementation.
func (a *Acc) ToolExtra(callID string, embedMs, dbMs float64) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if r, ok := a.tools[callID]; ok {
		r.EmbedMs, r.DBMs = &embedMs, &dbMs
	}
}

// ToolEnd records the end of a tool call and adds its duration to tool_ms.
func (a *Acc) ToolEnd(callID string, result map[string]any, err error) {
	if a == nil {
		return
	}
	a.mu.Lock()
	r, ok := a.tools[callID]
	if ok && !r.Done {
		r.Duration = time.Since(r.start)
		r.Result, r.Err, r.Done = result, err, true
	}
	a.mu.Unlock()
	if ok {
		a.AddTool(r.Duration)
	}
}

// TakeTool returns a finished, not-yet-emitted tool record and marks it emitted.
func (a *Acc) TakeTool(callID string) (ToolRecord, bool) {
	if a == nil {
		return ToolRecord{}, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	r, ok := a.tools[callID]
	if !ok || !r.Done || r.Emitted {
		return ToolRecord{}, false
	}
	r.Emitted = true
	return *r, true
}

// TakeRemainingTools returns finished, not-yet-emitted records in call order.
func (a *Acc) TakeRemainingTools() []ToolRecord {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []ToolRecord
	for _, id := range a.order {
		if r := a.tools[id]; r.Done && !r.Emitted {
			r.Emitted = true
			out = append(out, *r)
		}
	}
	return out
}

// Timings is the contract Timings object (float milliseconds).
type Timings struct {
	ServerTotalMs float64 `json:"server_total_ms"`
	FirstTokenMs  float64 `json:"first_token_ms"`
	ModelMs       float64 `json:"model_ms"`
	ToolMs        float64 `json:"tool_ms"`
	SessionMs     float64 `json:"session_ms"`
	OverheadMs    float64 `json:"overhead_ms"`
}

// Ms converts a duration to float milliseconds.
func Ms(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e6 }

// Round3 rounds to 3 decimal places (microsecond resolution in ms).
func Round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// Compute derives the Timings given the request's total duration.
func Compute(total, firstToken, model, tool, session time.Duration) Timings {
	overhead := total - model - tool - session
	if overhead < 0 {
		overhead = 0
	}
	return Timings{
		ServerTotalMs: Round3(Ms(total)),
		FirstTokenMs:  Round3(Ms(firstToken)),
		ModelMs:       Round3(Ms(model)),
		ToolMs:        Round3(Ms(tool)),
		SessionMs:     Round3(Ms(session)),
		OverheadMs:    Round3(Ms(overhead)),
	}
}

// Finish computes the timings at this instant.
func (a *Acc) Finish() Timings {
	total := time.Since(a.Start)
	a.mu.Lock()
	ft := a.firstToken
	a.mu.Unlock()
	return Compute(total, ft, a.Model(), a.Tool(), a.Session())
}
