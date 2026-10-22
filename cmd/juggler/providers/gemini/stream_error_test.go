//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"fmt"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"

	"google.golang.org/genai"
)

// classifyStreamError is the whole of gemini's contract with the worker's retry
// loop. These cases assert the mapping in the terms the loop actually uses —
// the kind provider.ClassifyFailure gives the error — so a mapping that
// silently stopped being retryable fails here.

func TestClassifyStreamErrorKinds(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		want provider.FailureKind
	}{
		{"internal", 500, provider.FailureServerError},
		{"bad gateway", 502, provider.FailureServerError},
		{"service unavailable", 503, provider.FailureOverloaded},
		{"gateway timeout", 504, provider.FailureServerError},
		// The non-standard 529 a Google frontend returns for a momentarily
		// saturated model.
		{"overloaded", 529, provider.FailureOverloaded},
		{"rate limit", 429, provider.FailureRateLimited},
		{"client error", 400, provider.FailureInvalidRequest},
		{"permission", 403, provider.FailureAuth},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := classifyStreamError(genai.APIError{Code: tc.code, Message: "upstream said no", Status: "UNAVAILABLE"})
			if got := provider.ClassifyFailure(err).Kind; got != tc.want {
				t.Fatalf("code %d classified %v, want %v (%q)", tc.code, got, tc.want, err.Error())
			}
			if !strings.Contains(err.Error(), "upstream said no") {
				t.Fatalf("underlying provider text must survive, got %q", err.Error())
			}
			if !strings.Contains(err.Error(), "gemini") {
				t.Fatalf("error must name the provider, got %q", err.Error())
			}
		})
	}
}

// The SDK hands back genai.APIError by value, and callers wrap it, so the
// classification has to survive both. A pointer-typed assertion (which is what
// the retired googleapi.Error branch used) matches neither.
func TestClassifyStreamErrorUnwrapsWrappedAPIError(t *testing.T) {
	wrapped := fmt.Errorf("stream failed: %w", genai.APIError{Code: 503, Message: "model overloaded"})
	if got := provider.ClassifyFailure(classifyStreamError(wrapped)).Kind; got != provider.FailureOverloaded {
		t.Fatalf("a wrapped 503 classified %v, want overloaded", got)
	}
}
