package bench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lalala0095/go-benchmarking/go-server/internal/testutil"
)

type expected struct {
	CPU struct {
		N    int    `json:"n"`
		Hash string `json:"hash"`
	} `json:"cpu_n25"`
	JSON struct {
		ItemCount int     `json:"item_count"`
		Total     float64 `json:"total"`
		EchoLen   int     `json:"echo_len"`
	} `json:"json"`
}

func load(t *testing.T) (expected, []byte) {
	dir := filepath.Join(testutil.ContractsDir(t), "fixtures")
	var e expected
	raw, err := os.ReadFile(filepath.Join(dir, "expected-bench.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "json-10kb.json"))
	if err != nil {
		t.Fatal(err)
	}
	return e, body
}

func TestCPUHash(t *testing.T) {
	e, _ := load(t)
	if got := CPUHash(e.CPU.N); got != e.CPU.Hash {
		t.Fatalf("CPUHash(%d) = %s, want %s", e.CPU.N, got, e.CPU.Hash)
	}
}

func TestProcessJSON(t *testing.T) {
	e, body := load(t)
	res, err := ProcessJSON(body)
	if err != nil {
		t.Fatal(err)
	}
	if res.ItemCount != e.JSON.ItemCount || res.Total != e.JSON.Total || len(res.Echo) != e.JSON.EchoLen {
		t.Fatalf("got count=%d total=%v echo=%d, want %+v", res.ItemCount, res.Total, len(res.Echo), e.JSON)
	}
	// Echo is the first 10 items verbatim.
	var doc struct{ Items []map[string]any }
	_ = json.Unmarshal(body, &doc)
	var echo []map[string]any
	b, _ := json.Marshal(res.Echo)
	_ = json.Unmarshal(b, &echo)
	if echo[0]["sku"] != doc.Items[0]["sku"] || echo[9]["id"] != doc.Items[9]["id"] {
		t.Fatal("echo mismatch")
	}
	if _, err := ProcessJSON([]byte(`{"x":1}`)); err == nil {
		t.Fatal("expected error for missing items")
	}
}

func TestRound2(t *testing.T) {
	cases := map[float64]float64{0.125: 0.13, -0.125: -0.13, 16235.129999: 16235.13, 2.5: 2.5}
	for in, want := range cases {
		if got := Round2(in); got != want {
			t.Errorf("Round2(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestRandomID(t *testing.T) {
	for i := 0; i < 1000; i++ {
		if id := RandomID(); id < 1 || id > 100000 {
			t.Fatal(id)
		}
	}
}
