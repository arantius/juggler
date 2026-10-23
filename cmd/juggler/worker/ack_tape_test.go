//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// An ack the worker sends is on its tape. The viewer's tape has the request
// leaving and the ack arriving; this is the moment between, and without it a
// client's ack timeout cannot say whether the worker answered late, answered
// someone else, or never answered at all.
func TestAnAckIsOnTheTape(t *testing.T) {
	enableEventTape(t)
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.handleClearUndoStacks(json.RawMessage(`{"ackId":"wm_test_ack_1"}`))

	sent := tapeEventsOfKind(w.tape.DumpAll(), "ack-sent")
	if len(sent) != 1 {
		t.Fatalf("the tape holds %d ack-sent events, want 1", len(sent))
	}
	if got := sent[0].Summary["ackId"]; got != "wm_test_ack_1" {
		t.Errorf("ack-sent names ackId %v, want wm_test_ack_1", got)
	}
}
