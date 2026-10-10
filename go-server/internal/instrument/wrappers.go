package instrument

import (
	"context"
	"iter"
	"time"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
)

// ModelError wraps an error returned by the underlying model so the API
// layer can classify it as UPSTREAM_*.
type ModelError struct{ Err error }

func (e *ModelError) Error() string { return e.Err.Error() }
func (e *ModelError) Unwrap() error { return e.Err }

// timedModel is a model.LLM decorator that accumulates model_ms: wall time
// from calling the model to its last chunk, summed over calls.
type timedModel struct{ inner model.LLM }

// WrapModel returns a timing decorator for m.
func WrapModel(m model.LLM) model.LLM { return &timedModel{inner: m} }

func (t *timedModel) Name() string { return t.inner.Name() }

// GetGoogleLLMVariant forwards ADK's backend detection to the wrapped model.
func (t *timedModel) GetGoogleLLMVariant() genai.Backend {
	if v, ok := t.inner.(interface{ GetGoogleLLMVariant() genai.Backend }); ok {
		return v.GetGoogleLLMVariant()
	}
	return genai.BackendUnspecified
}

func (t *timedModel) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		acc := From(ctx)
		start := time.Now()
		last := start
		defer func() { acc.AddModel(last.Sub(start)) }()
		for resp, err := range t.inner.GenerateContent(ctx, req, stream) {
			last = time.Now()
			if err != nil {
				acc.SetModelErr(err)
				err = &ModelError{Err: err}
			}
			if !yield(resp, err) {
				return
			}
		}
	}
}

// timedSessions decorates a session.Service, timing every method.
type timedSessions struct{ inner session.Service }

// WrapSessions returns a timing decorator for s.
func WrapSessions(s session.Service) session.Service { return &timedSessions{inner: s} }

func (t *timedSessions) Create(ctx context.Context, r *session.CreateRequest) (*session.CreateResponse, error) {
	defer t.time(ctx, time.Now())
	return t.inner.Create(ctx, r)
}

func (t *timedSessions) Get(ctx context.Context, r *session.GetRequest) (*session.GetResponse, error) {
	defer t.time(ctx, time.Now())
	return t.inner.Get(ctx, r)
}

func (t *timedSessions) List(ctx context.Context, r *session.ListRequest) (*session.ListResponse, error) {
	defer t.time(ctx, time.Now())
	return t.inner.List(ctx, r)
}

func (t *timedSessions) Delete(ctx context.Context, r *session.DeleteRequest) error {
	defer t.time(ctx, time.Now())
	return t.inner.Delete(ctx, r)
}

func (t *timedSessions) AppendEvent(ctx context.Context, s session.Session, e *session.Event) error {
	defer t.time(ctx, time.Now())
	return t.inner.AppendEvent(ctx, s, e)
}

func (t *timedSessions) time(ctx context.Context, start time.Time) {
	From(ctx).AddSession(time.Since(start))
}
