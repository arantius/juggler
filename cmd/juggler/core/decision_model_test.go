//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

func newTestDecisionModelStore(t *testing.T) *DecisionModelStore {
	t.Helper()
	userpathstest.Isolate(t)
	s, err := NewDecisionModelStore()
	if err != nil {
		t.Fatalf("NewDecisionModelStore: %v", err)
	}
	return s
}

func TestDecisionModelMissingFileIsUnset(t *testing.T) {
	s := newTestDecisionModelStore(t)
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != (ModelRef{}) {
		t.Fatalf("got %+v, want nothing chosen", got)
	}
}

func TestDecisionModelRoundTrip(t *testing.T) {
	s := newTestDecisionModelStore(t)
	want := ModelRef{Provider: "jev", Model: "jev-latest"}
	if err := s.Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != want {
		t.Fatalf("round-trip = %+v, want %+v", got, want)
	}
}

// A decision model has no reasoning level or serving tier, so a ref that carries
// them must not store dials nothing will ever read back.
func TestDecisionModelDropsDialsItDoesNotHave(t *testing.T) {
	s := newTestDecisionModelStore(t)
	if err := s.Save(ModelRef{Provider: "jev", Model: "jev-latest", Thinking: "high", ServiceTier: "priority"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != (ModelRef{Provider: "jev", Model: "jev-latest"}) {
		t.Fatalf("got %+v, want only provider and model", got)
	}
	raw, err := os.ReadFile(filepath.Join(userpaths.ConfigDir(), "decision-model.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"thinking", "serviceTier"} {
		if strings.Contains(string(raw), field) {
			t.Fatalf("file stores %q: %s", field, raw)
		}
	}
}

func TestDecisionModelEmptyRefClears(t *testing.T) {
	s := newTestDecisionModelStore(t)
	if err := s.Save(ModelRef{Provider: "jev", Model: "jev-latest"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	for _, clear := range []ModelRef{{}, {Provider: "jev"}, {Model: "jev-latest"}} {
		if err := s.Save(ModelRef{Provider: "jev", Model: "jev-latest"}); err != nil {
			t.Fatalf("Save: %v", err)
		}
		if err := s.Save(clear); err != nil {
			t.Fatalf("Save(%+v): %v", clear, err)
		}
		got, err := s.Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if got != (ModelRef{}) {
			t.Fatalf("after Save(%+v) got %+v, want nothing chosen", clear, got)
		}
	}
	// Clearing what is not there is not an error.
	if err := s.Save(ModelRef{}); err != nil {
		t.Fatalf("clearing an absent file: %v", err)
	}
}

func TestDecisionModelCorruptFileIsAnError(t *testing.T) {
	s := newTestDecisionModelStore(t)
	if err := os.MkdirAll(userpaths.ConfigDir(), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "decision-model.json"), []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(); err == nil {
		t.Fatal("a corrupt file loaded without error")
	}
}
