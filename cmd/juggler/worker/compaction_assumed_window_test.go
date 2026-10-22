//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/internal/jlog"
)

// guessedWindowResolver answers every model with an 8192-token window the
// provider did not report, on a provider that does or does not reject an
// over-long request, per rejects.
func guessedWindowResolver(rejects bool) WindowResolverFunc {
	return func(ModelConfig) ContextWindowInfo {
		return ContextWindowInfo{WindowTokens: 8192, ReserveTokens: 1638, Assumed: true, OverflowRejected: rejects}
	}
}

// newAssumedWindowWorker is a processing worker holding the recovery fixture's
// history, resolving every model through resolve.
func newAssumedWindowWorker(t *testing.T, resolve WindowResolverFunc) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker("test-conv", "user:test")
	t.Cleanup(w.doc.Destroy)
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.InsertMessage(0, recoveryTestItems()...)
	w.SetWindowResolver(resolve)
	return w
}

// TestAssumedWindowOnRejectingProviderDoesNotFold is the incident: a model
// whose real window was 872k ran against a 272k stand-in after its catalogue
// failed to load, and a measured count over the stand-in's ceiling summarized
// ~300k tokens of history on a paid model. Against a guessed window, a
// provider that rejects an over-long request is the only judge worth paying
// for, so even a measured advisory dispatches bypassed instead of folding — and
// the rejection, should one come, still folds.
func TestAssumedWindowOnRejectingProviderDoesNotFold(t *testing.T) {
	w := newAssumedWindowWorker(t, guessedWindowResolver(true))
	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		return nil, errors.New("reducer must not run against a guessed window the provider can judge")
	})
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}

	before := len(w.doc.GetItems())
	retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(advisoryLimitErr(true), true), &compactionAttempts{}, pinned)
	if !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a guard-bypassed dispatch", retry, err)
	}
	if got := len(w.doc.GetItems()); got != before {
		t.Fatalf("durable items changed %d -> %d; a guessed window must not rewrite history", before, got)
	}

	calls, stub := newRecoveryStub(t, pinned)
	w.SetLLMCaller(stub)
	if retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(recoveryLimitErr(), false), &compactionAttempts{}, pinned); !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want the provider's rejection to fold and retry", retry, err)
	}
	if *calls == 0 {
		t.Fatal("no hidden calls — a provider rejection must still fold against a guessed window")
	}
}

// TestAssumedWindowOnTruncatingProviderStillFolds is the counterpart: a local
// server that silently drops what does not fit is no judge at all, so for it
// the guessed window remains the only protection and a measured advisory folds.
func TestAssumedWindowOnTruncatingProviderStillFolds(t *testing.T) {
	w := newAssumedWindowWorker(t, guessedWindowResolver(false))
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	calls, stub := newRecoveryStub(t, pinned)
	w.SetLLMCaller(stub)

	if retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(advisoryLimitErr(true), true), &compactionAttempts{}, pinned); !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a fold and a bypassed retry", retry, err)
	}
	if *calls == 0 {
		t.Fatal("no hidden calls — a truncating provider must still be protected by its guessed window")
	}
}

// readConvLog closes w's conversation log and returns what it holds.
func readConvLog(t *testing.T, w *ConversationWorker, path string) string {
	t.Helper()
	w.log.Close()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the conversation log: %v", err)
	}
	return string(data)
}

// TestAutoCompactionIsInTheConversationLog pins the record a compaction leaves
// where a user goes to ask why one ran: the conversation log says it started,
// on what estimate, against which window, and whether that window is a guess.
// A compaction can run for minutes of hidden calls before it reaches an outcome
// line, and one that is stopped never reaches it.
func TestAutoCompactionIsInTheConversationLog(t *testing.T) {
	w := newAssumedWindowWorker(t, assumedResolver(false))
	logPath := filepath.Join(t.TempDir(), "conv.log")
	w.log = jlog.NewLogger(logPath, 1, 1)
	pinned := &ModelConfig{Provider: "original", Model: "rejected"}
	_, stub := newRecoveryStub(t, pinned)
	w.SetLLMCaller(stub)

	if retry, err := w.ownedRun(t).handleContextOverflow(testOverflow(advisoryLimitErr(true), true), &compactionAttempts{}, pinned); !retry || err != nil {
		t.Fatalf("retry = %v, err = %v; want a fold and a bypassed retry", retry, err)
	}

	log := readConvLog(t, w, logPath)
	for _, want := range []string{
		"[context guard] compacting", "measured=3500", "window=4000", "assumed=false",
		"[compaction] started (kind=auto",
	} {
		if !strings.Contains(log, want) {
			t.Errorf("conversation log lacks %q:\n%s", want, log)
		}
	}
}

// TestStoppedCompactionLogsWhatItSpent: a compaction that is cancelled or fails
// still spent its hidden calls, and the log is the one place a user can read
// what they cost.
func TestStoppedCompactionLogsWhatItSpent(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	t.Cleanup(w.doc.Destroy)
	logPath := filepath.Join(t.TempDir(), "conv.log")
	w.log = jlog.NewLogger(logPath, 1, 1)

	spent := CompactionResult{Passes: 1, Calls: 3, Usage: CompactionUsage{InputTokens: 307548, OutputTokens: 13689}}
	w.currentRun().recordCompactionOutcome(compactionKindAuto, "cancelled", spent, nil)
	w.currentRun().recordCompactionOutcome(compactionKindShrink, "error", spent, map[string]any{"toolUseId": "toolu_1"})

	log := readConvLog(t, w, logPath)
	for _, want := range []string{
		"[compaction] cancelled (kind=auto", "[compaction] error (kind=shrink",
		"calls=3", "input=307548", "output=13689",
	} {
		if !strings.Contains(log, want) {
			t.Errorf("conversation log lacks %q:\n%s", want, log)
		}
	}
}
