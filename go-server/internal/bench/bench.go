// Package bench implements the L1/L2 /bench/* endpoints (TRD §5.4,
// contracts/openapi.yaml).
package bench

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"math/rand/v2"
	"time"
)

// CPUHash computes h = sha256("bench-seed"), then n*1000 times h = sha256(h)
// over the raw 32-byte digest, and returns hex(h).
func CPUHash(n int) string {
	h := sha256.Sum256([]byte("bench-seed"))
	for i := 0; i < n*1000; i++ {
		h = sha256.Sum256(h[:])
	}
	return hex.EncodeToString(h[:])
}

// JSONResult is the /bench/json response.
type JSONResult struct {
	ItemCount int               `json:"item_count"`
	Total     float64           `json:"total"`
	Echo      []json.RawMessage `json:"echo"`
}

// ErrNoItems reports a body without an items array.
var ErrNoItems = errors.New("body must be an object with an items array")

// ProcessJSON parses the body, sums item prices (rounded to 2 dp, half away
// from zero) and echoes the first 10 items verbatim.
func ProcessJSON(body []byte) (*JSONResult, error) {
	var doc struct {
		Items *[]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	if doc.Items == nil {
		return nil, ErrNoItems
	}
	items := *doc.Items
	var total float64
	for _, raw := range items {
		var it struct {
			Price float64 `json:"price"`
		}
		if err := json.Unmarshal(raw, &it); err != nil {
			return nil, err
		}
		total += it.Price
	}
	echo := items[:min(10, len(items))]
	return &JSONResult{ItemCount: len(items), Total: Round2(total), Echo: echo}, nil
}

// Round2 rounds half away from zero to 2 decimal places.
func Round2(v float64) float64 { return math.Round(v*100) / 100 }

// RandomID returns a random bench_items id in 1..100000.
func RandomID() int { return rand.IntN(100000) + 1 }

// Ms converts a duration to float milliseconds.
func Ms(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e6 }
