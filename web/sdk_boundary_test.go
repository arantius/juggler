//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package web

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The SDK/app boundary is declared once, in tooling/sdk-boundary.json. The
// juggler/sdk-boundary ESLint rule holds the code to it — every relative
// import across the boundary is declared, and every declaration is an import
// that exists — and this test holds LICENSING.md, the public statement of it,
// to the same file.
const (
	sdkBoundaryFile = "../tooling/sdk-boundary.json"
	licensingFile   = "../LICENSING.md"
	boundaryBegin   = "<!-- sdk-boundary:begin — rendered from tooling/sdk-boundary.json by TestLicensingBoundaryAudit (web/sdk_boundary_test.go); UPDATE=1 rewrites it -->"
	boundaryEnd     = "<!-- sdk-boundary:end -->"
)

type boundaryEntry struct {
	Why     string   `json:"why"`
	Imports []string `json:"imports"`
}

type boundaryDecl struct {
	SDK        map[string]boundaryEntry `json:"sdk"`
	Extensions map[string]boundaryEntry `json:"extensions"`
}

func readBoundary(t *testing.T) boundaryDecl {
	t.Helper()
	src, err := os.ReadFile(sdkBoundaryFile)
	if err != nil {
		t.Fatal(err)
	}
	var decl boundaryDecl
	if err := json.Unmarshal(src, &decl); err != nil {
		t.Fatalf("tooling/sdk-boundary.json: %v", err)
	}
	return decl
}

// webPath is a repo-relative path as LICENSING.md writes it, relative to web/.
func webPath(p string) string { return "`" + strings.TrimPrefix(p, "web/") + "`" }

func sortedEntryKeys(m map[string]boundaryEntry) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func renderBindings(b *strings.Builder, entries map[string]boundaryEntry) {
	for _, file := range sortedEntryKeys(entries) {
		e := entries[file]
		targets := make([]string, len(e.Imports))
		for i, imp := range e.Imports {
			targets[i] = webPath(imp)
		}
		b.WriteString("  - " + webPath(file) + " → " + strings.Join(targets, ", ") + " — " + e.Why + "\n")
	}
}

// renderBoundaryAudit renders the generated part of LICENSING.md's boundary
// audit. selfContained is the SDK entry modules with no declared binding.
func renderBoundaryAudit(decl boundaryDecl, selfContained []string) string {
	var b strings.Builder
	b.WriteString(boundaryBegin + "\n")
	quoted := make([]string, len(selfContained))
	for i, f := range selfContained {
		quoted[i] = webPath(f)
	}
	b.WriteString("- **Self-contained**: these SDK entry modules import no app code: " +
		strings.Join(quoted, ", ") + ". Nothing under `sdk/lib/` imports app code either, except where listed next.\n")
	b.WriteString("- **Declared host bindings**: the SDK is the *interface* to a running Juggler\n" +
		"  host, and these modules bind it to the host's AGPL implementation:\n")
	renderBindings(&b, decl.SDK)
	b.WriteString("- **Bundled extensions that reach past the SDK**: every other module under\n" +
		"  `extensions/` reaches the host only through `juggler/*` specifiers, as a\n" +
		"  third-party extension must. These are the exceptions — mostly built-ins that\n" +
		"  are part of the app's own features — and are not templates for those parts:\n")
	renderBindings(&b, decl.Extensions)
	b.WriteString(boundaryEnd)
	return b.String()
}

// TestLicensingBoundaryAudit holds LICENSING.md's boundary audit to
// tooling/sdk-boundary.json, and every file the declarations name to the tree.
// UPDATE=1 rewrites the section between the markers.
func TestLicensingBoundaryAudit(t *testing.T) {
	decl := readBoundary(t)

	for _, group := range []map[string]boundaryEntry{decl.SDK, decl.Extensions} {
		for file, e := range group {
			if e.Why == "" {
				t.Errorf("tooling/sdk-boundary.json: %s has no \"why\"", file)
			}
			for _, p := range append([]string{file}, e.Imports...) {
				if _, err := os.Stat("../" + p); err != nil {
					t.Errorf("tooling/sdk-boundary.json names %s, which does not exist — remove it", p)
				}
			}
		}
	}

	entries, err := filepath.Glob("sdk/*.js")
	if err != nil {
		t.Fatal(err)
	}
	var selfContained []string
	for _, e := range entries {
		e = "web/" + filepath.ToSlash(e)
		if _, bound := decl.SDK[e]; !bound {
			selfContained = append(selfContained, e)
		}
	}
	sort.Strings(selfContained)

	got := renderBoundaryAudit(decl, selfContained)
	src, err := os.ReadFile(licensingFile)
	if err != nil {
		t.Fatal(err)
	}
	doc := string(src)
	start := strings.Index(doc, boundaryBegin)
	end := strings.Index(doc, boundaryEnd)
	if start < 0 || end < start {
		t.Fatalf("LICENSING.md has no %q … %q section", boundaryBegin, boundaryEnd)
	}
	current := doc[start : end+len(boundaryEnd)]
	if current == got {
		return
	}
	if os.Getenv("UPDATE") == "1" {
		if err := os.WriteFile(licensingFile, []byte(doc[:start]+got+doc[end+len(boundaryEnd):]), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("rewrote the boundary audit in LICENSING.md")
		return
	}
	t.Errorf("LICENSING.md's boundary audit is stale — run UPDATE=1 make check RUN='TestLicensingBoundaryAudit' to rewrite it. It should read:\n%s", got)
}
