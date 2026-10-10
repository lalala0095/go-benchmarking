// Package metrics exposes the Prometheus metrics of TRD §7 with their exact
// names, including bench_cgroup_* read from cgroup v2 files at scrape time.
package metrics

import (
	"bufio"
	"net"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds the registry and server metrics.
type Metrics struct {
	Registry     *prometheus.Registry
	HTTPRequests *prometheus.CounterVec
	HTTPDuration *prometheus.HistogramVec
	ChatOverhead *prometheus.HistogramVec
	ChatModel    *prometheus.HistogramVec
}

// New registers all metrics. pool may be nil (pool gauges then report 0).
func New(pool *pgxpool.Pool, cgroupRoot string) *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		Registry: reg,
		HTTPRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "bench_http_requests_total", Help: "HTTP requests by route pattern and status.",
		}, []string{"route", "status"}),
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "bench_http_request_duration_seconds",
			Help:    "HTTP request duration by route pattern (streams: until the stream ends).",
			Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30},
		}, []string{"route"}),
		ChatOverhead: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "bench_chat_overhead_seconds",
			Help:    "Chat overhead (total - model - tool - session) per request.",
			Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1},
		}, []string{"mode"}),
		ChatModel: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "bench_chat_model_seconds",
			Help:    "Time spent awaiting the model per chat request.",
			Buckets: []float64{.05, .1, .25, .5, 1, 1.25, 1.5, 2, 3, 5, 10, 30},
		}, []string{"mode"}),
	}
	reg.MustRegister(m.HTTPRequests, m.HTTPDuration, m.ChatOverhead, m.ChatModel)
	reg.MustRegister(
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "bench_db_pool_in_use", Help: "Acquired pgxpool connections."},
			func() float64 {
				if pool == nil {
					return 0
				}
				return float64(pool.Stat().AcquiredConns())
			}),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "bench_db_pool_max", Help: "pgxpool max connections."},
			func() float64 {
				if pool == nil {
					return 0
				}
				return float64(pool.Stat().MaxConns())
			}),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "bench_runtime_threads", Help: "Go: number of goroutines."},
			func() float64 { return float64(runtime.NumGoroutine()) }),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		collectors.NewGoCollector(),
		&cgroupCollector{root: cgroupRoot},
	)
	return m
}

// Handler serves /metrics.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{})
}

// ObserveChat records per-request chat histograms.
func (m *Metrics) ObserveChat(mode string, overhead, model time.Duration) {
	m.ChatOverhead.WithLabelValues(mode).Observe(overhead.Seconds())
	m.ChatModel.WithLabelValues(mode).Observe(model.Seconds())
}

// Middleware counts requests and durations by route pattern.
func (m *Metrics) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		route := RouteLabel(r.Pattern)
		m.HTTPRequests.WithLabelValues(route, strconv.Itoa(sw.status)).Inc()
		m.HTTPDuration.WithLabelValues(route).Observe(time.Since(start).Seconds())
	})
}

// RouteLabel strips the method from a ServeMux pattern ("GET /x/{id}" -> "/x/{id}").
func RouteLabel(pattern string) string {
	if pattern == "" {
		return "unmatched"
	}
	if i := strings.IndexByte(pattern, ' '); i >= 0 {
		return strings.TrimSpace(pattern[i+1:])
	}
	return pattern
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status, s.wroteHeader = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	s.wroteHeader = true
	return s.ResponseWriter.Write(b)
}

// Flush supports SSE through the wrapper.
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Hijack is forwarded for completeness.
func (s *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(s.ResponseWriter).Hijack()
}

// cgroupCollector reads cgroup v2 files at scrape time; metrics are omitted
// when the files are missing.
type cgroupCollector struct{ root string }

var (
	descCPU       = prometheus.NewDesc("bench_cgroup_cpu_usage_seconds_total", "cgroup v2 cpu.stat usage_usec in seconds (whole container).", nil, nil)
	descThrottled = prometheus.NewDesc("bench_cgroup_cpu_throttled_seconds_total", "cgroup v2 cpu.stat throttled_usec in seconds.", nil, nil)
	descMem       = prometheus.NewDesc("bench_cgroup_memory_bytes", "cgroup v2 memory.current.", nil, nil)
)

func (c *cgroupCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- descCPU
	ch <- descThrottled
	ch <- descMem
}

func (c *cgroupCollector) Collect(ch chan<- prometheus.Metric) {
	if s, ok := readFile(c.root, "cpu.stat"); ok {
		if st, ok := ParseCPUStat(s); ok {
			ch <- prometheus.MustNewConstMetric(descCPU, prometheus.CounterValue, float64(st.UsageUsec)/1e6)
			if st.HasThrottled {
				ch <- prometheus.MustNewConstMetric(descThrottled, prometheus.CounterValue, float64(st.ThrottledUsec)/1e6)
			}
		}
	}
	if s, ok := readFile(c.root, "memory.current"); ok {
		if v, ok := ParseUint(s); ok {
			ch <- prometheus.MustNewConstMetric(descMem, prometheus.GaugeValue, float64(v))
		}
	}
}
