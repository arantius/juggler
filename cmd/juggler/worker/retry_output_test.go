//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// streamedOutput is the model output the document holds, in order: what the
// user reads in the transcript, and what the next request sends back as
// history.
func streamedOutput(w *ConversationWorker) []string {
	var out []string
	for _, it := range w.doc.GetItems() {
		switch it.Type {
		case ItemTypeAssistant, ItemTypeThinking:
			out = append(out, it.Type+": "+it.Content)
		case ItemTypeProviderState:
			out = append(out, it.Type)
		}
	}
	return out
}

// partialThenDropped streams half an answer — thinking, provider state, text —
// and then loses the connection.
func partialThenDropped(sink func(StreamChunk)) error {
	sink(StreamChunk{Type: provider.ContentBlockTypeThinking, Content: "Weighing it up"})
	sink(StreamChunk{Type: provider.ContentBlockTypeProviderState, Metadata: map[string]any{"responseId": "r1"}})
	sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: "Half an ans"})
	return fmt.Errorf("anthropic streaming error: %w", io.ErrUnexpectedEOF)
}

// TestRetryDiscardsTheFailedAttemptsOutput: an attempt that streamed part of
// an answer and then failed is retried, and what it streamed goes. Left in
// place, the transcript reads as a half-answer followed by a whole one, and the
// half-answer is sent back to the model as history on the next turn.
func TestRetryDiscardsTheFailedAttemptsOutput(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	fastRetries(w)

	calls := 0
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		calls++
		if calls == 1 {
			return nil, partialThenDropped(sink)
		}
		sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: "The whole answer."})
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "The whole answer."}}}, nil
	})

	if _, err := w.currentRun().callLLMWithRetry(nil); err != nil {
		t.Fatalf("callLLMWithRetry: %v", err)
	}
	if calls != 2 {
		t.Fatalf("provider calls = %d, want 2", calls)
	}
	if got, want := streamedOutput(w), []string{"assistant: The whole answer."}; !slices.Equal(got, want) {
		t.Fatalf("document holds %q, want only the retry's answer %q", got, want)
	}
}

// TestTerminalFailureKeepsWhatStreamed: a failure that ends the turn leaves the
// last attempt's output where it landed, beside the error. Only an attempt that
// is replaced by another is discarded.
func TestTerminalFailureKeepsWhatStreamed(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	fastRetries(w)

	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		return nil, partialThenDropped(sink)
	})

	if _, err := w.currentRun().callLLMWithRetry(nil); err == nil {
		t.Fatal("callLLMWithRetry succeeded against a provider that always fails")
	}
	want := []string{"thinking: Weighing it up", ItemTypeProviderState, "assistant: Half an ans"}
	if got := streamedOutput(w); !slices.Equal(got, want) {
		t.Fatalf("document holds %q, want exactly the last attempt's output %q", got, want)
	}
}
