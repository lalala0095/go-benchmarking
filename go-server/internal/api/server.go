// Package api implements the shared HTTP contract (contracts/openapi.yaml,
// contracts/sse-events.md) on the stdlib ServeMux.
package api

import (
	"context"
	"errors"
	"net/http"
	"runtime"
	"runtime/debug"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/genai"

	"google.golang.org/adk/v2/session"

	"github.com/lalala0095/go-benchmarking/go-server/internal/agent"
	"github.com/lalala0095/go-benchmarking/go-server/internal/config"
	"github.com/lalala0095/go-benchmarking/go-server/internal/metrics"
	"github.com/lalala0095/go-benchmarking/go-server/internal/rag"
)

// Server holds the dependencies of all handlers.
type Server struct {
	Cfg        *config.Config
	Pool       *pgxpool.Pool
	Sessions   session.Service // timed decorator around ADK's database service
	Runners    *agent.Runners
	RAG        *rag.Service
	Metrics    *metrics.Metrics
	StartedAt  time.Time
	CgroupRoot string
}

// Handler builds the routed, instrumented handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /v1/info", s.info)
	mux.Handle("GET /metrics", s.Metrics.Handler())

	mux.HandleFunc("POST /v1/sessions", s.createSession)
	mux.HandleFunc("GET /v1/sessions/{session_id}", s.getSession)
	mux.HandleFunc("DELETE /v1/sessions/{session_id}", s.deleteSession)

	mux.HandleFunc("POST /v1/chat", s.chat)
	mux.HandleFunc("POST /v1/chat/stream", s.chatStream)

	mux.HandleFunc("POST /v1/rag/ingest", s.ragIngest)
	mux.HandleFunc("POST /v1/rag/chunk", s.ragChunk)
	mux.HandleFunc("POST /v1/rag/embed", s.ragEmbed)
	mux.HandleFunc("GET /v1/rag/search", s.ragSearch)
	mux.HandleFunc("GET /v1/rag/stats", s.ragStats)
	mux.HandleFunc("DELETE /v1/rag/documents", s.ragDelete)

	mux.HandleFunc("GET /bench/ping", s.benchPing)
	mux.HandleFunc("POST /bench/json", s.benchJSON)
	mux.HandleFunc("GET /bench/cpu", s.benchCPU)
	mux.HandleFunc("GET /bench/sleep", s.benchSleep)
	mux.HandleFunc("GET /bench/db/read", s.benchDBRead)
	mux.HandleFunc("GET /bench/db/query", s.benchDBQuery)
	mux.HandleFunc("POST /bench/db/write", s.benchDBWrite)

	var h http.Handler = mux
	h = withStart(h)
	if s.Metrics != nil {
		h = s.Metrics.Middleware(h)
	}
	return h
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.Pool.Ping(ctx); err != nil {
		writeJSON(w, r, http.StatusServiceUnavailable, map[string]string{"status": "degraded", "db": "error"})
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]string{"status": "ok", "db": "ok"})
}

// ADKVersion returns the ADK-Go module version from build info.
func ADKVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "google.golang.org/adk/v2" {
				if d.Replace != nil {
					return d.Replace.Version
				}
				return d.Version
			}
		}
	}
	return "unknown"
}

func (s *Server) info(w http.ResponseWriter, r *http.Request) {
	cpu, mem := metrics.CgroupLimits(s.CgroupRoot)
	writeJSON(w, r, http.StatusOK, map[string]any{
		"impl":                      "go",
		"runtime":                   runtime.Version(),
		"adk_version":               ADKVersion(),
		"framework":                 "net/http",
		"workers":                   1,
		"gomaxprocs":                runtime.GOMAXPROCS(0),
		"model":                     s.Cfg.GeminiModel,
		"embed_model":               s.Cfg.GeminiEmbedModel,
		"gemini_configured":         s.Cfg.GeminiConfigured(),
		"db_pool_max":               s.Cfg.DBPoolMax,
		"cgroup_cpu_limit":          cpu,
		"cgroup_memory_limit_bytes": mem,
		"started_at":                s.StartedAt.UTC().Format(time.RFC3339Nano),
	})
}

// ---------------------------------------------------------------------------
// Sessions

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserID string `json:"user_id"`
	}
	if err := decodeJSON(r, &req); err != nil || req.UserID == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "user_id is required", "")
		return
	}
	t0 := time.Now()
	resp, err := s.Sessions.Create(r.Context(), &session.CreateRequest{AppName: agent.AppName, UserID: req.UserID})
	st := timing{"session", ms(time.Since(t0))}
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, CodeInternal, err.Error(), "")
		return
	}
	writeJSON(w, r, http.StatusCreated, map[string]any{
		"session_id": resp.Session.ID(),
		"user_id":    resp.Session.UserID(),
		"created_at": resp.Session.LastUpdateTime().UTC().Format(time.RFC3339Nano),
	}, st)
}

// HistoryEvent is one entry of GET /v1/sessions/{id}.
type HistoryEvent struct {
	Role string `json:"role"`
	Text string `json:"text"`
	Tool string `json:"tool,omitempty"`
	TS   string `json:"ts"`
}

// MapEvent maps an ADK session event to the contract history shape:
// user text → "user"; function call/response → "tool" (tool = name);
// other model output → "model".
func MapEvent(ev *session.Event) HistoryEvent {
	he := HistoryEvent{Role: "model", TS: ev.Timestamp.UTC().Format(time.RFC3339Nano)}
	if ev.Author == "user" {
		he.Role = "user"
	}
	if c := ev.Content; c != nil {
		var sb strings.Builder
		for _, p := range c.Parts {
			if p == nil {
				continue
			}
			switch {
			case p.FunctionCall != nil:
				he.Role, he.Tool = "tool", p.FunctionCall.Name
			case p.FunctionResponse != nil:
				he.Role, he.Tool = "tool", p.FunctionResponse.Name
			case p.Text != "" && !p.Thought:
				sb.WriteString(p.Text)
			}
		}
		he.Text = sb.String()
		if c.Role == genai.RoleUser && he.Role == "model" {
			he.Role = "user"
		}
	}
	return he
}

func (s *Server) lookupSession(w http.ResponseWriter, r *http.Request, recent int) (session.Session, timing, bool) {
	id, user := r.PathValue("session_id"), r.URL.Query().Get("user_id")
	if user == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "user_id query parameter is required", "")
		return nil, timing{}, false
	}
	t0 := time.Now()
	resp, err := s.Sessions.Get(r.Context(), &session.GetRequest{AppName: agent.AppName, UserID: user, SessionID: id, NumRecentEvents: recent})
	st := timing{"session", ms(time.Since(t0))}
	if err != nil {
		if errors.Is(err, session.ErrNotFound) {
			writeError(w, r, http.StatusNotFound, CodeSessionNotFound, "session not found", "")
		} else {
			writeError(w, r, http.StatusInternalServerError, CodeInternal, err.Error(), "")
		}
		return nil, st, false
	}
	return resp.Session, st, true
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	sess, st, ok := s.lookupSession(w, r, 0)
	if !ok {
		return
	}
	events := make([]HistoryEvent, 0, sess.Events().Len())
	for ev := range sess.Events().All() {
		if ev.Partial {
			continue
		}
		events = append(events, MapEvent(ev))
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"session_id": sess.ID(), "events": events}, st)
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	sess, st, ok := s.lookupSession(w, r, 1)
	if !ok {
		return
	}
	t0 := time.Now()
	err := s.Sessions.Delete(r.Context(), &session.DeleteRequest{AppName: agent.AppName, UserID: sess.UserID(), SessionID: sess.ID()})
	st.ms += ms(time.Since(t0))
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, CodeInternal, err.Error(), "")
		return
	}
	writeNoContent(w, r, st)
}
