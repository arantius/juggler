//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"juggler/internal/atomicio"
	"juggler/internal/userpaths"
)

// DecisionModelStore persists the user's chosen decision model: the model that
// answers yes/no, choice and score questions where a chat model would only be
// asked for a verdict, such as Auto-approve's review of a parked tool call. It
// lives in ~/.juggler/decision-model.json (0600, owner-only).
//
// An absent file means nothing is chosen, and the work that would have used a
// decision model runs on the cheap model instead, as it did before decision
// models existed. That is the reason there is no "off" setting as the cheap
// model has: leaving it unset already is the off state, and nothing needs
// telling apart from it.
//
// Only the provider and model are kept. A decision model has no reasoning level
// or serving tier to pin, so those fields of a ModelRef are dropped on Save
// rather than stored and never read.
type DecisionModelStore struct {
	filePath string
}

// NewDecisionModelStore creates a store rooted at ~/.juggler.
func NewDecisionModelStore() (*DecisionModelStore, error) {
	return &DecisionModelStore{
		filePath: filepath.Join(userpaths.ConfigDir(), "decision-model.json"),
	}, nil
}

// Load reads the stored decision model. Returns the zero ModelRef when the file
// does not exist or is empty, i.e. nothing chosen.
func (s *DecisionModelStore) Load() (ModelRef, error) {
	data, err := os.ReadFile(s.filePath)
	if os.IsNotExist(err) {
		return ModelRef{}, nil
	}
	if err != nil {
		return ModelRef{}, fmt.Errorf("failed to read decision model file: %w", err)
	}
	if len(data) == 0 {
		return ModelRef{}, nil
	}

	var ref ModelRef
	if err := json.Unmarshal(data, &ref); err != nil {
		return ModelRef{}, fmt.Errorf("failed to parse decision model file: %w", err)
	}
	return ModelRef{Provider: ref.Provider, Model: ref.Model}, nil
}

// Save persists the decision model. An empty provider or model clears the
// stored choice by deleting the file, since absence is how "nothing chosen" is
// spelled.
func (s *DecisionModelStore) Save(ref ModelRef) error {
	if ref.Provider == "" || ref.Model == "" {
		if err := os.Remove(s.filePath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to clear decision model file: %w", err)
		}
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(s.filePath), 0700); err != nil {
		return fmt.Errorf("failed to create decision model directory: %w", err)
	}

	data, err := json.MarshalIndent(ModelRef{Provider: ref.Provider, Model: ref.Model}, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal decision model: %w", err)
	}
	if err := atomicio.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write decision model file: %w", err)
	}
	return nil
}
