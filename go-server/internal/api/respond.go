package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

// Error codes (contracts/openapi.yaml Error.code).
const (
	CodeBadRequest      = "BAD_REQUEST"
	CodeSessionNotFound = "SESSION_NOT_FOUND"
	CodeNotFound        = "NOT_FOUND"
	CodeUpstream429     = "UPSTREAM_429"
	CodeUpstreamError   = "UPSTREAM_ERROR"
	CodeInternal        = "INTERNAL"
)

// APIError is the JSON error body.
type APIError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

type startKey struct{}

// withStart stores the request start time in the context.
func withStart(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r2 := r.WithContext(context.WithValue(r.Context(), startKey{}, time.Now()))
		next.ServeHTTP(w, r2)
		r.Pattern = r2.Pattern // ServeMux sets it on the copy; metrics read it from r

	})
}

func requestStart(r *http.Request) time.Time {
	if t, ok := r.Context().Value(startKey{}).(time.Time); ok {
		return t
	}
	return time.Now()
}

// timing is one Server-Timing metric.
type timing struct {
	name string
	ms   float64
}

func ms(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e6 }

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// setServerTiming writes "Server-Timing: total;dur=X[, name;dur=Y...]".
func setServerTiming(w http.ResponseWriter, r *http.Request, extra ...timing) {
	var sb strings.Builder
	fmt.Fprintf(&sb, "total;dur=%.3f", ms(time.Since(requestStart(r))))
	for _, t := range extra {
		fmt.Fprintf(&sb, ", %s;dur=%.3f", t.name, t.ms)
	}
	w.Header().Set("Server-Timing", sb.String())
}

// marshal encodes v as single-line JSON without HTML escaping.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// writeJSON writes a JSON response with Server-Timing.
func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any, extra ...timing) {
	b, err := marshal(v)
	if err != nil {
		status = http.StatusInternalServerError
		b = []byte(`{"code":"INTERNAL","message":"encode error"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	setServerTiming(w, r, extra...)
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// writeError writes a JSON error body.
func writeError(w http.ResponseWriter, r *http.Request, status int, code, msg, requestID string) {
	if status >= 500 && r.Context().Err() != nil {
		// Client went away (context canceled): record as 499, not a server error.
		status = statusClientClosed
	}
	writeJSON(w, r, status, APIError{Code: code, Message: msg, RequestID: requestID})
}

func writeNoContent(w http.ResponseWriter, r *http.Request, extra ...timing) {
	setServerTiming(w, r, extra...)
	w.WriteHeader(http.StatusNoContent)
}

const maxBody = 32 << 20

// statusClientClosed is nginx's 499 "client closed request".
const statusClientClosed = 499

// readBody reads the request body (bounded).
func readBody(r *http.Request) ([]byte, error) {
	return io.ReadAll(http.MaxBytesReader(nil, r.Body, maxBody))
}

// decodeJSON decodes the body into v.
func decodeJSON(r *http.Request, v any) error {
	b, err := readBody(r)
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return fmt.Errorf("empty body")
	}
	return json.Unmarshal(b, v)
}
