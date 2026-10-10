package agent

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lalala0095/go-benchmarking/go-server/internal/rag"
	"github.com/lalala0095/go-benchmarking/go-server/internal/testutil"
)

func TestCurrentTime(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 30, 45, 999, time.UTC)
	got := CurrentTime("Asia/Manila", now)
	if got["iso"] != "2026-10-10T20:30:45+08:00" || got["timezone"] != "Asia/Manila" || got["note"] != nil {
		t.Fatalf("%v", got)
	}
	if got := CurrentTime("UTC", now); got["iso"] != "2026-10-10T12:30:45Z" {
		t.Fatalf("%v", got)
	}
	got = CurrentTime("Mars/Olympus", now)
	if got["timezone"] != "UTC" || got["note"] != "unknown timezone, used UTC" || got["iso"] != "2026-10-10T12:30:45Z" {
		t.Fatalf("%v", got)
	}
}

func TestTruncate(t *testing.T) {
	if Truncate("héllo", 2) != "hé" || Truncate("abc", 800) != "abc" || len([]rune(Truncate(strings.Repeat("日", 900), 800))) != 800 {
		t.Fatal("Truncate")
	}
}

func TestToolsBuildAndInstruction(t *testing.T) {
	tools, err := NewTools(nil, &rag.Service{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{ToolSearch: descSearch, ToolInventory: descInventory, ToolTime: descTime}
	for _, tl := range tools {
		if want[tl.Name()] != tl.Description() {
			t.Errorf("tool %s description %q", tl.Name(), tl.Description())
		}
		delete(want, tl.Name())
	}
	if len(want) != 0 {
		t.Fatalf("missing tools %v", want)
	}
	ins, err := LoadInstruction(filepath.Join(testutil.ContractsDir(t), "agent-instruction.txt"))
	if err != nil || !strings.HasPrefix(ins, "You are bench_agent") {
		t.Fatalf("instruction: %v", err)
	}
}
