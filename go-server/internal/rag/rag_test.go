package rag

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/genai"

	"github.com/lalala0095/go-benchmarking/go-server/internal/testutil"
)

type expectedChunks struct {
	Source      string  `json:"source"`
	Title       string  `json:"title"`
	ContentHash string  `json:"content_hash"`
	Chunks      []Chunk `json:"chunks"`
}

func TestChunkerFixtures(t *testing.T) {
	dir := filepath.Join(testutil.ContractsDir(t), "fixtures", "rag-chunking")
	files, err := filepath.Glob(filepath.Join(dir, "expected", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no fixtures: %v", err)
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			var exp expectedChunks
			if err := json.Unmarshal(raw, &exp); err != nil {
				t.Fatal(err)
			}
			in, err := os.ReadFile(filepath.Join(dir, "cases", exp.Source))
			if err != nil {
				t.Fatal(err)
			}
			text := string(in)
			if got := TitleOf(text, exp.Source); got != exp.Title {
				t.Errorf("title = %q, want %q", got, exp.Title)
			}
			if got := ContentHash(text); got != exp.ContentHash {
				t.Errorf("hash = %s, want %s", got, exp.ContentHash)
			}
			got := ChunkText(text)
			if len(got) != len(exp.Chunks) {
				t.Fatalf("got %d chunks, want %d", len(got), len(exp.Chunks))
			}
			for i := range got {
				if got[i] != exp.Chunks[i] {
					t.Errorf("chunk %d mismatch:\n got  %#v\n want %#v", i, got[i], exp.Chunks[i])
				}
			}
			// Byte-equal JSON of the chunk list.
			gj, _ := json.Marshal(got)
			ej, _ := json.Marshal(exp.Chunks)
			if string(gj) != string(ej) {
				t.Errorf("chunk JSON differs")
			}
		})
	}
}

func TestMockEmbedFixture(t *testing.T) {
	dir := filepath.Join(testutil.ContractsDir(t), "fixtures", "rag-embed")
	var texts []string
	raw, _ := os.ReadFile(filepath.Join(dir, "texts.json"))
	if err := json.Unmarshal(raw, &texts); err != nil {
		t.Fatal(err)
	}
	var exp struct {
		Dim       int         `json:"dim"`
		Tolerance float64     `json:"tolerance"`
		Vectors   [][]float64 `json:"vectors"`
	}
	raw, _ = os.ReadFile(filepath.Join(dir, "expected-mock.json"))
	if err := json.Unmarshal(raw, &exp); err != nil {
		t.Fatal(err)
	}
	if len(exp.Vectors) != len(texts) || exp.Dim != EmbedDim {
		t.Fatalf("fixture shape mismatch")
	}
	m := &MockEmbedder{BatchSize: 100}
	vecs, err := m.Embed(context.Background(), texts, TaskDocument)
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range vecs {
		if len(v) != EmbedDim {
			t.Fatalf("dim %d", len(v))
		}
		for j := range v {
			if d := math.Abs(float64(v[j]) - exp.Vectors[i][j]); d > exp.Tolerance {
				t.Fatalf("text %d comp %d: got %v want %v", i, j, v[j], exp.Vectors[i][j])
			}
		}
	}
}

func TestMockEmbedderDelayPerBatch(t *testing.T) {
	m := &MockEmbedder{BatchSize: 2, Delay: 20 * time.Millisecond}
	t0 := time.Now()
	if _, err := m.Embed(context.Background(), []string{"a", "b", "c"}, TaskQuery); err != nil {
		t.Fatal(err)
	}
	if el := time.Since(t0); el < 40*time.Millisecond || el > 200*time.Millisecond {
		t.Fatalf("elapsed %v, want ~40ms (2 batches)", el)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.Embed(ctx, []string{"a"}, TaskQuery); err == nil {
		t.Fatal("expected context error")
	}
}

func TestWalkCorpus(t *testing.T) {
	dir := t.TempDir()
	for _, p := range []string{"b.md", "a/z.txt", "a/y.md", "private/secret.md", "x.json", "c.MD"} {
		full := filepath.Join(dir, p)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		_ = os.WriteFile(full, []byte("x"), 0o644)
	}
	got, err := WalkCorpus(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a/y.md", "a/z.txt", "b.md", "c.MD"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	got, _ = WalkCorpus(dir, true)
	if len(got) != 5 {
		t.Fatalf("include_private: got %v", got)
	}
}

func TestLoadStatements(t *testing.T) {
	st, err := LoadStatements(filepath.Join(testutil.ContractsDir(t), "sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(st) != 6 {
		t.Fatalf("got %d statements", len(st))
	}
	for name, sql := range st {
		if strings.Contains(sql, "{{EMB_COL}}") {
			t.Errorf("%s still has token", name)
		}
	}
	if !strings.Contains(st[StmtName(ModeHybrid, EmbedderGemini)], "embedding_gemini") {
		t.Error("gemini column missing")
	}
}

// TestGeminiEmbedderFake drives the real genai client against a fake
// batchEmbedContents endpoint: batching, task type, retry on 429, L2 norm.
func TestGeminiEmbedderFake(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"code":429,"message":"slow down","status":"RESOURCE_EXHAUSTED"}}`))
			return
		}
		var body struct {
			Requests []struct {
				TaskType             string `json:"taskType"`
				OutputDimensionality int    `json:"outputDimensionality"`
			} `json:"requests"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		type emb struct {
			Values []float32 `json:"values"`
		}
		out := struct {
			Embeddings []emb `json:"embeddings"`
		}{}
		for _, rq := range body.Requests {
			if rq.TaskType != "" || rq.OutputDimensionality != 768 {
				w.WriteHeader(400)
				return
			}
			v := make([]float32, 768)
			v[0], v[1] = 3, 4
			out.Embeddings = append(out.Embeddings, emb{v})
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer srv.Close()
	g, err := NewGeminiEmbedder(context.Background(), "fake-key", "gemini-embedding-2", 2, &genai.HTTPOptions{BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	g.BackoffBase = time.Millisecond
	vecs, err := g.Embed(context.Background(), []string{"a", "b", "c"}, TaskQuery)
	if err != nil {
		t.Fatal(err)
	}
	if len(vecs) != 3 || math.Abs(float64(vecs[2][0])-0.6) > 1e-6 || math.Abs(float64(vecs[2][1])-0.8) > 1e-6 {
		t.Fatalf("bad vectors: %v", vecs[2][:2])
	}
	if c := calls.Load(); c != 3 { // 429 + 2 batches
		t.Fatalf("calls = %d, want 3", c)
	}
}

func TestGeminiTaskTypeOverride(t *testing.T) {
	g := &GeminiEmbedder{}
	if g.taskType(TaskQuery) != "" {
		t.Fatal("default must omit task type")
	}
	g.TaskType = "retrieval"
	if g.taskType(TaskQuery) != "RETRIEVAL_QUERY" || g.taskType(TaskDocument) != "RETRIEVAL_DOCUMENT" {
		t.Fatal("retrieval mapping")
	}
	g.TaskType = "SEMANTIC_SIMILARITY"
	if g.taskType(TaskQuery) != "SEMANTIC_SIMILARITY" {
		t.Fatal("literal")
	}
}
