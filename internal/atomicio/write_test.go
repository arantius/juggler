//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package atomicio

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"testing"
)

// onlyEntry fails the test unless dir holds exactly the one file named want:
// a temp file left behind is litter in a config directory forever.
func onlyEntry(t *testing.T, dir, want string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 1 || names[0] != want {
		t.Fatalf("directory holds %q, want only %q", names, want)
	}
}

func TestWriteFile_CreatesWithContentAndMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	if err := WriteFile(path, []byte(`{"a":1}`), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != `{"a":1}` {
		t.Fatalf("read back %q (%v), want the bytes written", got, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Errorf("mode %v, want 0600", mode)
		}
	}
	onlyEntry(t, dir, "settings.json")
}

// The mode is the one asked for, not the temp file's, whatever is replaced.
func TestWriteFile_ModeIsTheOneAskedFor(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits")
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("new"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o644 {
		t.Errorf("mode %v, want 0644", mode)
	}
}

// The replacement is a new file published over the name, never the old one
// truncated and rewritten in place — so anyone holding the old file sees it
// whole, never torn. A hard link to the original is such a holder: it must
// still read the old bytes afterwards.
func TestWriteFile_ReplacesRatherThanRewrites(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("hard links to an open-and-replaced file are a POSIX observation")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "recents.json")
	if err := os.WriteFile(path, []byte("the old contents"), 0o600); err != nil {
		t.Fatal(err)
	}
	held := filepath.Join(dir, "held")
	if err := os.Link(path, held); err != nil {
		t.Skipf("hard links unsupported here: %v", err)
	}

	if err := WriteFile(path, []byte("new"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "new" {
		t.Errorf("path reads %q, want the new bytes", got)
	}
	if got, _ := os.ReadFile(held); string(got) != "the old contents" {
		t.Errorf("the old file reads %q afterwards, want it untouched: it was rewritten in place", got)
	}
}

// A write that cannot be published leaves nothing behind: not a temp file, and
// not a damaged destination.
func TestWriteFile_FailureLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	// A directory where the file should go: the publish cannot replace it.
	path := filepath.Join(dir, "taken")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "inside"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("x"), 0o600); err == nil {
		t.Fatal("WriteFile over a non-empty directory succeeded")
	}
	onlyEntry(t, dir, "taken")

	if err := WriteFile(filepath.Join(dir, "missing", "f"), []byte("x"), 0o600); err == nil {
		t.Fatal("WriteFile into a directory that does not exist succeeded")
	}
	onlyEntry(t, dir, "taken")
}

// RemoveTemps takes exactly the temp files WriteFile names for path, and
// nothing that merely resembles one: not the file itself, not another file's
// temps, not a name WriteFile would never generate.
func TestRemoveTemps_RemovesOnlyThisFilesTemps(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "workspace.json")
	if err := WriteFile(path, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	kept := []string{
		"workspace.json",
		"workspace.json.corrupt",
		".workspace.json.tmp",
		".workspace.json.notanumber.tmp",
		".settings.json.123.tmp",
		"workspace.json.123.tmp",
	}
	removed := []string{".workspace.json.1840525170.tmp", ".workspace.json.7.tmp"}
	for _, name := range append(kept[1:], removed...) {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if err := RemoveTemps(path); err != nil {
		t.Fatalf("RemoveTemps: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	slices.Sort(got)
	want := slices.Sorted(slices.Values(kept))
	if !slices.Equal(got, want) {
		t.Errorf("directory holds %q, want %q", got, want)
	}

	if err := RemoveTemps(filepath.Join(dir, "missing", "f")); err != nil {
		t.Errorf("RemoveTemps beside a directory that does not exist: %v, want nil", err)
	}
}

// Racing writers each publish a complete file: whichever lands last, the result
// is exactly one writer's bytes, never an interleaving or a longer write's tail.
func TestWriteFile_ConcurrentWritersNeverTear(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	payloads := make([][]byte, 8)
	for i := range payloads {
		payloads[i] = bytes.Repeat([]byte(fmt.Sprintf("%d", i)), 1000*(len(payloads)-i))
	}

	var wg sync.WaitGroup
	for round := 0; round < 20; round++ {
		for _, p := range payloads {
			wg.Add(1)
			go func(p []byte) {
				defer wg.Done()
				_ = WriteFile(path, p, 0o600)
			}(p)
		}
	}
	wg.Wait()

	got, err := RobustReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	for _, p := range payloads {
		if bytes.Equal(got, p) {
			onlyEntry(t, dir, "state.json")
			return
		}
	}
	t.Fatalf("the file holds %d bytes matching no single writer", len(got))
}
