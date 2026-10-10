package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseCPUStat(t *testing.T) {
	st, ok := ParseCPUStat("usage_usec 1234567\nuser_usec 1000\nsystem_usec 234\nnr_periods 10\nnr_throttled 2\nthrottled_usec 5000\n")
	if !ok || st.UsageUsec != 1234567 || st.ThrottledUsec != 5000 || !st.HasThrottled {
		t.Fatalf("got %+v", st)
	}
	if _, ok := ParseCPUStat("garbage"); ok {
		t.Fatal("want !ok")
	}
}

func TestParseLimits(t *testing.T) {
	if v := ParseCPUMax("200000 100000\n"); v == nil || *v != 2 {
		t.Fatalf("cpu.max 2 cpus: %v", v)
	}
	if v := ParseCPUMax("max 100000\n"); v != nil {
		t.Fatal("unlimited must be nil")
	}
	if v := ParseCPUMax("150000 100000"); *v != 1.5 {
		t.Fatal(*v)
	}
	if v := ParseMemoryMax("1073741824\n"); v == nil || *v != 1<<30 {
		t.Fatal("memory.max")
	}
	if ParseMemoryMax("max\n") != nil {
		t.Fatal("max must be nil")
	}
	if v, ok := ParseUint(" 42\n"); !ok || v != 42 {
		t.Fatal("ParseUint")
	}
}

func scrape(t *testing.T, m *Metrics) string {
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	b, _ := io.ReadAll(rec.Body)
	return string(b)
}

func TestCgroupCollectorAndNames(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "cpu.stat"), []byte("usage_usec 2500000\nthrottled_usec 500000\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "memory.current"), []byte("104857600\n"), 0o644)
	m := New(nil, dir)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /x/{id}", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(201) })
	h := m.Middleware(mux)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x/123", nil))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/nope", nil))
	m.ObserveChat("mock", 1e6, 1e9)

	out := scrape(t, m)
	for _, want := range []string{
		`bench_http_requests_total{route="/x/{id}",status="201"} 1`,
		`bench_http_requests_total{route="unmatched",status="404"} 1`,
		`bench_http_request_duration_seconds_bucket{route="/x/{id}"`,
		`bench_chat_overhead_seconds_bucket{mode="mock"`,
		`bench_chat_model_seconds_bucket{mode="mock"`,
		"bench_db_pool_in_use 0", "bench_db_pool_max 0", "bench_runtime_threads ",
		"bench_cgroup_cpu_usage_seconds_total 2.5",
		"bench_cgroup_cpu_throttled_seconds_total 0.5",
		"bench_cgroup_memory_bytes 1.048576e+08",
		"process_cpu_seconds_total", "process_resident_memory_bytes",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}

	// Missing files: cgroup metrics absent, no error.
	out = scrape(t, New(nil, filepath.Join(dir, "missing")))
	if strings.Contains(out, "bench_cgroup_") {
		t.Error("cgroup metrics should be absent")
	}
}

func TestRouteLabel(t *testing.T) {
	if RouteLabel("GET /v1/sessions/{session_id}") != "/v1/sessions/{session_id}" || RouteLabel("") != "unmatched" {
		t.Fatal("RouteLabel")
	}
}
