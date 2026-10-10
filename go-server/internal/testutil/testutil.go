// Package testutil holds helpers shared by tests.
package testutil

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ContractsDir locates the contracts/ directory: $CONTRACTS_DIR, /contracts,
// or the repo-relative path.
func ContractsDir(t testing.TB) string {
	t.Helper()
	cands := []string{os.Getenv("CONTRACTS_DIR"), "/contracts"}
	if _, file, _, ok := runtime.Caller(0); ok {
		cands = append(cands, filepath.Join(filepath.Dir(file), "..", "..", "..", "contracts"))
	}
	for _, c := range cands {
		if c == "" {
			continue
		}
		if st, err := os.Stat(filepath.Join(c, "agent-spec.md")); err == nil && !st.IsDir() {
			return c
		}
	}
	t.Fatalf("contracts dir not found (set CONTRACTS_DIR)")
	return ""
}
