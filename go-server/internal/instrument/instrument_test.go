package instrument

import (
	"context"
	"errors"
	"iter"
	"testing"
	"time"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
)

func TestComputeMath(t *testing.T) {
	ms := time.Millisecond
	tm := Compute(1000*ms, 250*ms, 800*ms, 50*ms, 30*ms)
	if tm.OverheadMs != 120 || tm.ServerTotalMs != 1000 || tm.FirstTokenMs != 250 || tm.ModelMs != 800 || tm.ToolMs != 50 || tm.SessionMs != 30 {
		t.Fatalf("got %+v", tm)
	}
	if tm := Compute(100*ms, 0, 90*ms, 20*ms, 0); tm.OverheadMs != 0 {
		t.Fatalf("overhead must floor at 0, got %v", tm.OverheadMs)
	}
	if Round3(1.23456) != 1.235 {
		t.Fatal("Round3")
	}
}

type fakeModel struct {
	chunks int
	delay  time.Duration
	err    error
}

func (f *fakeModel) Name() string { return "fake" }
func (f *fakeModel) GenerateContent(ctx context.Context, _ *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		for i := 0; i < f.chunks; i++ {
			time.Sleep(f.delay)
			if !yield(&model.LLMResponse{Partial: true}, nil) {
				return
			}
		}
		if f.err != nil {
			yield(nil, f.err)
		}
	}
}

func TestTimedModelWallTimeToLastChunk(t *testing.T) {
	acc := New()
	ctx := With(context.Background(), acc)
	m := WrapModel(&fakeModel{chunks: 5, delay: 10 * time.Millisecond})
	for range m.GenerateContent(ctx, &model.LLMRequest{}, true) {
		time.Sleep(20 * time.Millisecond) // between chunks counts; after the last does not
	}
	got := acc.Model()
	if got < 130*time.Millisecond || got > 180*time.Millisecond {
		t.Fatalf("model time %v, want ~130ms (call to last chunk)", got)
	}
}

func TestTimedModelWrapsErrors(t *testing.T) {
	acc := New()
	ctx := With(context.Background(), acc)
	boom := errors.New("boom")
	var gotErr error
	for _, err := range WrapModel(&fakeModel{err: boom}).GenerateContent(ctx, &model.LLMRequest{}, true) {
		gotErr = err
	}
	var me *ModelError
	if !errors.As(gotErr, &me) || !errors.Is(gotErr, boom) || acc.ModelErr() != boom {
		t.Fatalf("got %v", gotErr)
	}
}

func TestTimedSessions(t *testing.T) {
	acc := New()
	ctx := With(context.Background(), acc)
	svc := WrapSessions(session.InMemoryService())
	resp, err := svc.Create(ctx, &session.CreateRequest{AppName: "a", UserID: "u"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get(ctx, &session.GetRequest{AppName: "a", UserID: "u", SessionID: resp.Session.ID()}); err != nil {
		t.Fatal(err)
	}
	if acc.Session() <= 0 {
		t.Fatal("session time not recorded")
	}
	// No accumulator in context: must not panic.
	if _, err := svc.Get(context.Background(), &session.GetRequest{AppName: "a", UserID: "u", SessionID: "nope"}); !errors.Is(err, session.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestToolRecords(t *testing.T) {
	acc := New()
	acc.ToolStart("c1", "get_inventory_stats", map[string]any{"category": "x"})
	time.Sleep(5 * time.Millisecond)
	acc.ToolExtra("c1", 1.5, 2.5)
	acc.ToolEnd("c1", map[string]any{"count": 1}, nil)
	acc.ToolEnd("c1", nil, nil) // duplicate end ignored
	if acc.Tool() < 5*time.Millisecond {
		t.Fatalf("tool time %v", acc.Tool())
	}
	rec, ok := acc.TakeTool("c1")
	if !ok || rec.Name != "get_inventory_stats" || *rec.EmbedMs != 1.5 || *rec.DBMs != 2.5 {
		t.Fatalf("rec %+v", rec)
	}
	if _, ok := acc.TakeTool("c1"); ok {
		t.Fatal("record emitted twice")
	}
	acc.ToolStart("c2", "x", nil)
	acc.ToolEnd("c2", nil, nil)
	if rest := acc.TakeRemainingTools(); len(rest) != 1 || rest[0].CallID != "c2" {
		t.Fatalf("remaining %+v", rest)
	}
	var nilAcc *Acc
	nilAcc.AddModel(time.Second) // nil-safe
	nilAcc.MarkFirstToken()
}
