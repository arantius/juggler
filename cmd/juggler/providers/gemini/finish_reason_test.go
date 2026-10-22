//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"

	"google.golang.org/genai"
)

// TestStreamEndClassifies pins what each way a Gemini stream ends means to the
// worker: a block on content grounds is a refusal no retry changes, and a
// stream whose candidates never said why they stopped was cut off.
func TestStreamEndClassifies(t *testing.T) {
	c := &Client{}
	for _, tc := range []struct {
		name   string
		reason genai.FinishReason
		want   provider.FailureKind
	}{
		{"safety", genai.FinishReasonSafety, provider.FailureRefused},
		{"recitation", genai.FinishReasonRecitation, provider.FailureRefused},
		{"no finish reason", "", provider.FailureTruncated},
		{"unspecified", genai.FinishReasonUnspecified, provider.FailureTruncated},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := c.processStreamResult(tc.reason, true, nil, 0, 0, nil)
			if got := provider.ClassifyFailure(err).Kind; got != tc.want {
				t.Fatalf("finish %q classified %v, want %v (%v)", tc.reason, got, tc.want, err)
			}
		})
	}
	if _, err := c.processStreamResult(genai.FinishReasonStop, true, nil, 0, 0, nil); err != nil {
		t.Fatalf("a stream that stopped normally failed: %v", err)
	}
}
