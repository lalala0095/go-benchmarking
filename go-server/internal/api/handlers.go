package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/lalala0095/go-benchmarking/go-server/internal/bench"
	"github.com/lalala0095/go-benchmarking/go-server/internal/rag"
)

// ragError maps RAG service errors to HTTP errors.
func ragError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, rag.ErrBadRequest):
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, err.Error(), "")
	case errors.Is(err, rag.ErrGeminiNotConfigured):
		writeError(w, r, http.StatusBadGateway, CodeUpstreamError, rag.ErrGeminiNotConfigured.Error(), "")
	case apiCode(err) == http.StatusTooManyRequests:
		writeError(w, r, http.StatusBadGateway, CodeUpstream429, err.Error(), "")
	case apiCode(err) != 0:
		writeError(w, r, http.StatusBadGateway, CodeUpstreamError, err.Error(), "")
	default:
		writeError(w, r, http.StatusInternalServerError, CodeInternal, err.Error(), "")
	}
}

// ---------------------------------------------------------------------------
// RAG

func (s *Server) ragIngest(w http.ResponseWriter, r *http.Request) {
	var req rag.IngestRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid JSON body", "")
		return
	}
	resp, err := s.RAG.Ingest(r.Context(), &req)
	if err != nil {
		ragError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, resp, timing{"embed", resp.Timings.EmbedMs}, timing{"db", resp.Timings.DBMs})
}

func (s *Server) ragChunk(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content *string `json:"content"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Content == nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "content is required", "")
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"chunks": rag.ChunkText(*req.Content)})
}

func (s *Server) ragEmbed(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	var req struct {
		Texts    []string `json:"texts"`
		Embedder string   `json:"embedder"`
		Task     string   `json:"task"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Texts == nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "texts is required", "")
		return
	}
	if len(req.Texts) > 256 {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "at most 256 texts", "")
		return
	}
	if req.Embedder == "" {
		req.Embedder = rag.EmbedderMock
	}
	task := rag.TaskDocument
	switch req.Task {
	case "", "document":
	case "query":
		task = rag.TaskQuery
	default:
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "task must be document or query", "")
		return
	}
	emb, err := s.RAG.Embedder(req.Embedder)
	if err != nil {
		ragError(w, r, err)
		return
	}
	e0 := time.Now()
	vecs, err := emb.Embed(r.Context(), req.Texts, task)
	embedMs := ms(time.Since(e0))
	if err != nil {
		ragError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"dim": rag.EmbedDim, "vectors": vecs,
		"timings": map[string]float64{"embed_ms": round3(embedMs), "total_ms": round3(ms(time.Since(start)))},
	}, timing{"embed", embedMs})
}

func (s *Server) ragSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	query := q.Get("q")
	if q.Get("preset") == "random" {
		p, ok := s.RAG.RandomPreset()
		if !ok {
			writeError(w, r, http.StatusInternalServerError, CodeInternal, "no preset queries loaded", "")
			return
		}
		query = p
	} else if p := q.Get("preset"); p != "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "preset must be random", "")
		return
	}
	if query == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "q is required unless preset=random", "")
		return
	}
	k := 5
	if ks := q.Get("k"); ks != "" {
		v, err := strconv.Atoi(ks)
		if err != nil || v < 1 || v > 20 {
			writeError(w, r, http.StatusBadRequest, CodeBadRequest, "k must be an integer in 1..20", "")
			return
		}
		k = v
	}
	mode := q.Get("mode")
	if mode == "" {
		mode = rag.ModeHybrid
	}
	embedder := q.Get("embedder")
	if embedder == "" {
		embedder = rag.EmbedderMock
	}
	if embedder != rag.EmbedderMock && embedder != rag.EmbedderGemini {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "embedder must be mock or gemini", "")
		return
	}
	res, t, err := s.RAG.Search(r.Context(), query, k, mode, embedder)
	if err != nil {
		ragError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"query": query, "mode": mode, "embedder": embedder, "results": res, "timings": t,
	}, timing{"embed", t.EmbedMs}, timing{"db", t.DBMs})
}

func (s *Server) ragStats(w http.ResponseWriter, r *http.Request) {
	t0 := time.Now()
	st, err := s.RAG.Store.Stats(r.Context())
	if err != nil {
		ragError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, st, timing{"db", ms(time.Since(t0))})
}

func (s *Server) ragDelete(w http.ResponseWriter, r *http.Request) {
	t0 := time.Now()
	if err := s.RAG.Store.Truncate(r.Context()); err != nil {
		ragError(w, r, err)
		return
	}
	writeNoContent(w, r, timing{"db", ms(time.Since(t0))})
}

// ---------------------------------------------------------------------------
// Bench

func (s *Server) benchPing(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) benchJSON(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, err.Error(), "")
		return
	}
	res, err := bench.ProcessJSON(body)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, err.Error(), "")
		return
	}
	writeJSON(w, r, http.StatusOK, res)
}

// intParam parses an optional integer query parameter within [lo, hi].
func intParam(r *http.Request, name string, def, lo, hi int) (int, bool) {
	s := r.URL.Query().Get(name)
	if s == "" {
		return def, true
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < lo || v > hi {
		return 0, false
	}
	return v, true
}

func (s *Server) benchCPU(w http.ResponseWriter, r *http.Request) {
	n, ok := intParam(r, "n", 25, 1, 1000)
	if !ok {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "n must be an integer in 1..1000", "")
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"n": n, "hash": bench.CPUHash(n)})
}

func (s *Server) benchSleep(w http.ResponseWriter, r *http.Request) {
	n, ok := intParam(r, "ms", 100, 0, 10000)
	if !ok {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "ms must be an integer in 0..10000", "")
		return
	}
	if err := rag.Sleep(r.Context(), time.Duration(n)*time.Millisecond); err != nil {
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]int{"slept_ms": n})
}

func (s *Server) benchDBRead(w http.ResponseWriter, r *http.Request) {
	id, ok := intParam(r, "id", 0, 1, 100000)
	if !ok {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "id must be an integer in 1..100000", "")
		return
	}
	if id == 0 {
		id = bench.RandomID()
	}
	t0 := time.Now()
	var item struct {
		ID         int             `json:"id"`
		SKU        string          `json:"sku"`
		Name       string          `json:"name"`
		Category   string          `json:"category"`
		Price      float64         `json:"price"`
		Stock      int             `json:"stock"`
		Attributes json.RawMessage `json:"attributes"`
	}
	err := s.Pool.QueryRow(r.Context(),
		`SELECT id, sku, name, category, price::float8, stock, attributes FROM app.bench_items WHERE id = $1`, id).
		Scan(&item.ID, &item.SKU, &item.Name, &item.Category, &item.Price, &item.Stock, &item.Attributes)
	db := timing{"db", ms(time.Since(t0))}
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "item not found", "")
		return
	}
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, CodeInternal, err.Error(), "")
		return
	}
	writeJSON(w, r, http.StatusOK, item, db)
}

func (s *Server) benchDBQuery(w http.ResponseWriter, r *http.Request) {
	t0 := time.Now()
	rows, err := s.Pool.Query(r.Context(),
		`SELECT category, count(*)::int, avg(price)::float8 FROM app.bench_items GROUP BY category ORDER BY category`)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, CodeInternal, err.Error(), "")
		return
	}
	type row struct {
		Category string  `json:"category"`
		Count    int     `json:"count"`
		AvgPrice float64 `json:"avg_price"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.Category, &x.Count, &x.AvgPrice); err != nil {
			rows.Close()
			writeError(w, r, http.StatusInternalServerError, CodeInternal, err.Error(), "")
			return
		}
		out = append(out, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, r, http.StatusInternalServerError, CodeInternal, err.Error(), "")
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"rows": out}, timing{"db", ms(time.Since(t0))})
}

func (s *Server) benchDBWrite(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil || !json.Valid(body) {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "body must be valid JSON", "")
		return
	}
	t0 := time.Now()
	var id int64
	if err := s.Pool.QueryRow(r.Context(), `INSERT INTO app.bench_writes(payload) VALUES ($1::jsonb) RETURNING id`, string(body)).Scan(&id); err != nil {
		writeError(w, r, http.StatusInternalServerError, CodeInternal, err.Error(), "")
		return
	}
	writeJSON(w, r, http.StatusCreated, map[string]int64{"id": id}, timing{"db", ms(time.Since(t0))})
}
