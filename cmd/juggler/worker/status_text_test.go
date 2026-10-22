//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// statusTextKey is the key of a status frame's (or processingState's) `text`
// message, or "" when it carries none.
func statusTextKey(frame map[string]any) string {
	text, _ := frame["text"].(map[string]any)
	key, _ := text["key"].(string)
	return key
}

// processingStateNow reads the doc's processingState blob.
func processingStateNow(w *ConversationWorker) map[string]any {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	state, _ := fromYcrdt(w.doc.metadata.Get("processingState")).(map[string]any)
	return state
}

// A retry's status line is words the user reads, so it reaches the client as a
// message beside the English — in the frame and in processingState — with the
// attempt and the time spent as data.
func TestRetryingStatusCarriesAMessage(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	fastRetries(w)
	w.turn.retrySpent = time.Minute

	frames := make(chan map[string]any, 32)
	w.SetCallback("viewer", func(b []byte) {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["type"] == "status" && m["status"] == "retrying" {
			frames <- m
		}
	})

	calls := 0
	var seen map[string]any
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		calls++
		if calls == 1 {
			return nil, failing(provider.FailureConnectionDropped, "connection reset by peer")
		}
		seen = processingStateNow(w)
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered"}}}, nil
	})
	if _, err := w.currentRun().callLLMWithRetry(nil); err != nil {
		t.Fatalf("callLLMWithRetry: %v", err)
	}

	const key = "Connection dropped, retrying ({attempt}/{max}){hasSpent, select, yes { — {spent} so far} other {}}"
	select {
	case m := <-frames:
		message, _ := m["message"].(string)
		if !strings.HasPrefix(message, "Connection dropped, retrying (1/3) — ") || !strings.HasSuffix(message, " so far") {
			t.Errorf("retrying message = %q, want the attempt and the time spent", message)
		}
		if got := statusTextKey(m); got != key {
			t.Errorf("retrying frame text key = %q, want %q", got, key)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no retrying frame was sent")
	}
	if got := statusTextKey(seen); got != key {
		t.Errorf("processingState text key = %q during the retry, want %q (state %v)", got, key, seen)
	}
}
