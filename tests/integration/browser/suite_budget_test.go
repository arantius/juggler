//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A passing suite's budget warning has to reach the file the Makefile reports
// from, because a passing subtest prints nothing without -v.
func TestSuiteBudgetWarningIsWrittenWhereTheRunReportsIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "suite-budget.log")
	t.Setenv(suiteBudgetLogEnv, path)

	recordSuiteBudget(t, "unit:slow 12.3s")
	recordSuiteBudget(t, "")

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the warning was not written: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(got), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("want one line (an empty warning is no warning), got %q", got)
	}
	if !strings.HasPrefix(lines[0], "unit:slow 12.3s\t") || !strings.Contains(lines[0], "MACHINE LOAD") {
		t.Fatalf("want the warning then the machine reading, got %q", lines[0])
	}
}
