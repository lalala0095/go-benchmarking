package api

import (
	"net/http"
)

// SSEWriter writes "event: <name>\ndata: <json>\n\n" frames and flushes each
// one immediately (contracts/sse-events.md).
type SSEWriter struct {
	w   http.ResponseWriter
	rc  *http.ResponseController
	buf []byte
	err error
}

// NewSSEWriter sends the stream headers (200, text/event-stream).
func NewSSEWriter(w http.ResponseWriter) *SSEWriter {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	return &SSEWriter{w: w, rc: http.NewResponseController(w)}
}

// Event writes and flushes one event. After the first write error every call
// returns that error (the client is gone).
func (s *SSEWriter) Event(name string, data any) error {
	if s.err != nil {
		return s.err
	}
	payload, err := marshal(data)
	if err != nil {
		return err
	}
	s.buf = s.buf[:0]
	s.buf = append(s.buf, "event: "...)
	s.buf = append(s.buf, name...)
	s.buf = append(s.buf, "\ndata: "...)
	s.buf = append(s.buf, payload...)
	s.buf = append(s.buf, "\n\n"...)
	if _, err := s.w.Write(s.buf); err != nil {
		s.err = err
		return err
	}
	if err := s.rc.Flush(); err != nil {
		s.err = err
		return err
	}
	return nil
}
