//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package wireschema

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// CompareGolden holds a rendering to the checked-in file at rel (relative to
// the module root). With UPDATE=1 in the environment it writes the file
// instead, and the test passes. Line endings aside: a Windows checkout gives
// the file CRLF (.gitattributes' `* text=auto`), and renderings are LF.
func CompareGolden(t testing.TB, rel, got string) {
	t.Helper()
	root, _ := ModuleRoot()
	if root == "" {
		t.Fatal("no go.mod above the working directory")
	}
	path := filepath.Join(root, filepath.FromSlash(rel))
	if os.Getenv("UPDATE") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", rel)
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v — run UPDATE=1 make test RUN='TestWireTypedefs' to write it", rel, err)
	}
	if w := strings.ReplaceAll(string(want), "\r\n", "\n"); w != got {
		t.Errorf("%s is stale — run UPDATE=1 make test RUN='TestWireTypedefs' to rewrite it:\n%s", rel, lineDiff(w, got))
	}
}

// lineDiff shows where got first parts from want: the line number and a few
// lines of each from there, enough to read a rendering change without a diff
// library.
func lineDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	i := 0
	for i < len(w) && i < len(g) && w[i] == g[i] {
		i++
	}
	window := func(lines []string) string {
		end := min(i+6, len(lines))
		if i >= end {
			return "  (end of file)\n"
		}
		return "  " + strings.Join(lines[i:end], "\n  ") + "\n"
	}
	return fmt.Sprintf("first difference at line %d\nwant:\n%sgot:\n%s", i+1, window(w), window(g))
}
