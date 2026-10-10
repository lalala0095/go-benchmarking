package metrics

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DefaultCgroupRoot is the cgroup v2 mount inside the container.
const DefaultCgroupRoot = "/sys/fs/cgroup"

// CPUStat holds the fields of cgroup v2 cpu.stat we export.
type CPUStat struct {
	UsageUsec     uint64
	ThrottledUsec uint64
	HasThrottled  bool
}

// ParseCPUStat parses cgroup v2 cpu.stat content.
func ParseCPUStat(content string) (CPUStat, bool) {
	var st CPUStat
	found := false
	sc := bufio.NewScanner(strings.NewReader(content))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) != 2 {
			continue
		}
		v, err := strconv.ParseUint(f[1], 10, 64)
		if err != nil {
			continue
		}
		switch f[0] {
		case "usage_usec":
			st.UsageUsec, found = v, true
		case "throttled_usec":
			st.ThrottledUsec, st.HasThrottled = v, true
		}
	}
	return st, found
}

// ParseCPUMax parses cpu.max ("<quota|max> <period>") into a CPU count, or
// nil when unlimited/invalid.
func ParseCPUMax(content string) *float64 {
	f := strings.Fields(content)
	if len(f) < 1 || f[0] == "max" {
		return nil
	}
	quota, err := strconv.ParseFloat(f[0], 64)
	if err != nil || quota <= 0 {
		return nil
	}
	period := 100000.0
	if len(f) >= 2 {
		if p, err := strconv.ParseFloat(f[1], 64); err == nil && p > 0 {
			period = p
		}
	}
	v := quota / period
	return &v
}

// ParseMemoryMax parses memory.max into bytes, or nil when "max"/invalid.
func ParseMemoryMax(content string) *int64 {
	s := strings.TrimSpace(content)
	if s == "" || s == "max" {
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return nil
	}
	return &v
}

// ParseUint parses a single-integer cgroup file such as memory.current.
func ParseUint(content string) (uint64, bool) {
	v, err := strconv.ParseUint(strings.TrimSpace(content), 10, 64)
	return v, err == nil
}

func readFile(root, name string) (string, bool) {
	b, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		return "", false
	}
	return string(b), true
}

// CgroupLimits returns cpu.max and memory.max limits (nil = unlimited/unknown).
func CgroupLimits(root string) (cpu *float64, mem *int64) {
	if s, ok := readFile(root, "cpu.max"); ok {
		cpu = ParseCPUMax(s)
	}
	if s, ok := readFile(root, "memory.max"); ok {
		mem = ParseMemoryMax(s)
	}
	return cpu, mem
}
