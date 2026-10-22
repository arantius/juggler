//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"testing"
	"time"
)

// TestClassifyFailure pins the kind every shape of provider failure lands in.
// The kind decides what the worker does, so both halves matter: a transport
// failure classed as terminal stops a turn a retry would have saved, and a
// refusal classed as transient hammers a provider that is telling us to stop.
func TestClassifyFailure(t *testing.T) {
	yes, no := true, false
	tests := []struct {
		name string
		err  error
		want FailureKind
	}{
		{"nil", nil, FailureNone},

		// The typed errors providers already raise.
		{"auth", &AuthError{Provider: "anthropic", Status: 401}, FailureAuth},
		{"setup", &SetupError{Provider: "claudecode"}, FailureSetup},
		{"rate limited", &RateLimitedError{RetryAfter: time.Minute, Message: "slow down"}, FailureRateLimited},
		{"unusable output", &UnusableOutputError{Message: "no tool"}, FailureUnusableOutput},
		{"context overflow", &ContextLimitExceededError{ContextWindowTokens: 1000}, FailureContextOverflow},
		{"context advisory", &ContextCompactionAdvisory{ContextWindowTokens: 1000}, FailureContextOverflow},
		{"unknown limits", &UnknownContextLimitError{}, FailureInvalidRequest},
		{"bad reserve", &InvalidOutputReserveError{}, FailureInvalidRequest},
		{"typed wins over wrapped transport", &AuthError{Provider: "x", Cause: io.ErrUnexpectedEOF}, FailureAuth},

		// A failure the provider has already judged.
		{"declared stall", NewFailureError(FailureStalled, "anthropic stream stalled", nil), FailureStalled},
		{"declared wins over its cause", NewFailureError(FailureStalled, "stalled", context.Canceled), FailureStalled},
		{"declared truncation", NewFailureError(FailureTruncated, "no message_stop", nil), FailureTruncated},

		// HTTP statuses, as a provider maps its SDK error onto APIError.
		{"500", &APIError{Status: 500}, FailureServerError},
		{"502", &APIError{Status: 502}, FailureServerError},
		{"504", &APIError{Status: 504}, FailureServerError},
		{"503", &APIError{Status: 503}, FailureOverloaded},
		{"529", &APIError{Status: 529}, FailureOverloaded},
		{"408", &APIError{Status: 408}, FailureServerError},
		{"409", &APIError{Status: 409}, FailureServerError},
		{"429", &APIError{Status: 429}, FailureRateLimited},
		{"429 out of quota", &APIError{Status: 429, Type: "insufficient_quota"}, FailureQuotaExhausted},
		{"503 with a generic server type", &APIError{Status: 503, Type: "server_error"}, FailureOverloaded},
		{"529 with its own type", &APIError{Status: 529, Type: "overloaded_error"}, FailureOverloaded},
		{"402", &APIError{Status: 402}, FailureQuotaExhausted},
		{"401", &APIError{Status: 401}, FailureAuth},
		{"403", &APIError{Status: 403}, FailureAuth},
		{"400", &APIError{Status: 400}, FailureInvalidRequest},
		{"404", &APIError{Status: 404}, FailureInvalidRequest},
		{"413", &APIError{Status: 413}, FailureInvalidRequest},
		{"422", &APIError{Status: 422}, FailureInvalidRequest},
		{"500 the server says not to retry", &APIError{Status: 500, ShouldRetry: &no}, FailureInvalidRequest},
		{"400 the server says to retry", &APIError{Status: 400, ShouldRetry: &yes}, FailureServerError},

		// An in-band error event, which arrives with no status.
		{"event overloaded_error", &APIError{Type: "overloaded_error"}, FailureOverloaded},
		{"event api_error", &APIError{Type: "api_error"}, FailureServerError},
		{"event server_error", &APIError{Type: "server_error"}, FailureServerError},
		{"event rate_limit_error", &APIError{Type: "rate_limit_error"}, FailureRateLimited},
		{"event invalid_request_error", &APIError{Type: "invalid_request_error"}, FailureInvalidRequest},
		{"event authentication_error", &APIError{Type: "authentication_error"}, FailureAuth},
		{"event billing_error", &APIError{Type: "billing_error"}, FailureQuotaExhausted},
		{"event with only a message", &APIError{Message: "Our servers are currently overloaded"}, FailureOverloaded},

		// The transport, as the standard library reports it. These are what a
		// stream that dies mid-body produces, and they must never be terminal.
		{"unexpected eof", fmt.Errorf("anthropic streaming error: %w", io.ErrUnexpectedEOF), FailureConnectionDropped},
		{"eof", io.EOF, FailureConnectionDropped},
		{"connection reset", &net.OpError{Op: "read", Net: "tcp", Err: os.NewSyscallError("read", syscall.ECONNRESET)}, FailureConnectionDropped},
		{"broken pipe", &net.OpError{Op: "write", Net: "tcp", Err: os.NewSyscallError("write", syscall.EPIPE)}, FailureConnectionDropped},
		{"connection aborted", syscall.ECONNABORTED, FailureConnectionDropped},
		{"dial refused", &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}, FailureUnreachable},
		{"dns", &net.DNSError{Err: "no such host", Name: "api.example.com"}, FailureUnreachable},
		{"net timeout", &net.OpError{Op: "read", Net: "tcp", Err: timeoutErr{}}, FailureStalled},
		{"deadline", context.DeadlineExceeded, FailureStalled},
		{"caller cancel", fmt.Errorf("request: %w", context.Canceled), FailureCancelled},
		{"untrusted certificate", &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}, FailureCertificate},
		{"expired certificate", fmt.Errorf("tls: %w", x509.CertificateInvalidError{Reason: x509.Expired}), FailureCertificate},

		// Nothing recognisable.
		{"unknown", errors.New("something odd happened"), FailureUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClassifyFailure(tt.err).Kind; got != tt.want {
				t.Fatalf("ClassifyFailure(%v).Kind = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

// TestClassifyFailureText pins the fallback for failures that arrive as text
// alone — the wire and scripted responses, and the claude CLI's result
// messages — where no type survives to be inspected.
func TestClassifyFailureText(t *testing.T) {
	tests := []struct {
		name string
		msg  string
		want FailureKind
	}{
		{"empty", "", FailureNone},
		{"anthropic overloaded mid-stream", `received error while streaming: {"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null}`, FailureOverloaded},
		{"overloaded_error type", `{"type":"overloaded_error"}`, FailureOverloaded},
		{"service unavailable", "503 Service Unavailable", FailureOverloaded},
		{"temporarily unavailable", "The model is temporarily unavailable", FailureOverloaded},
		{"bad gateway", "502 Bad Gateway", FailureServerError},
		{"gateway timeout", "504 Gateway Timeout", FailureServerError},
		{"internal server error", `POST "https://api.anthropic.com/v1/messages": 500 Internal Server Error {"type":"error","error":{"type":"api_error","message":"Internal server error"}}`, FailureServerError},
		{"openai server_error", `{"error":{"type":"server_error","message":"The server had an error"}}`, FailureServerError},
		{"stall", "anthropic " + StallMarker + ": no data for 1m30s — " + StallDroppedMarker, FailureStalled},
		{"i/o timeout", "read tcp 10.0.0.2:5123->1.2.3.4:443: i/o timeout", FailureStalled},
		{"h2 reset by server", "stream error: stream ID 5; INTERNAL_ERROR; received from peer", FailureConnectionDropped},
		{"h2 goaway", `http2: server sent GOAWAY and closed the connection; LastStreamID=9, ErrCode=NO_ERROR, debug=""`, FailureConnectionDropped},
		{"unexpected eof", "anthropic streaming error: unexpected EOF (the stream ran for 41.2s; its last event came 0.3s before the failure)", FailureConnectionDropped},
		{"connection reset", "read tcp 10.0.0.2:5123->1.2.3.4:443: read: connection reset by peer", FailureConnectionDropped},
		{"broken pipe", "write tcp 10.0.0.2:5123->1.2.3.4:443: write: broken pipe", FailureConnectionDropped},
		{"connection refused", "dial tcp 127.0.0.1:11434: connect: connection refused", FailureUnreachable},
		{"no such host", "dial tcp: lookup api.example.com: no such host", FailureUnreachable},
		{"no route", "dial tcp: no route to host", FailureUnreachable},
		{"rate limit", "429 Too Many Requests", FailureRateLimited},
		{"rate limit prose", "You have hit your rate limit", FailureRateLimited},
		{"quota beats 429", `429 {"error":{"code":"insufficient_quota"}}`, FailureQuotaExhausted},
		{"credit balance", "credit balance is too low", FailureQuotaExhausted},
		{"auth", "401 invalid x-api-key", FailureAuth},
		{"auth type", `{"type":"authentication_error"}`, FailureAuth},
		{"bad request", "400 invalid_request_error: max_tokens too large", FailureInvalidRequest},
		{"safety", "gemini blocked response due to safety filters", FailureRefused},
		{"content filter", "finish_reason: content_filter", FailureRefused},

		// Shapes that must not be mistaken for anything retryable.
		{"status digits alone", "read 503 bytes from tool output", FailureUnknown},
		{"h2 reset by us", "stream error: stream ID 5; CANCEL", FailureUnknown},
		{"cli exit", "claude exited unexpectedly", FailureUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClassifyFailureText(tt.msg).Kind; got != tt.want {
				t.Fatalf("ClassifyFailureText(%q).Kind = %v, want %v", tt.msg, got, tt.want)
			}
		})
	}
}

// TestClassifyFailureCarriesTheProvidersNumbers pins the fields beyond the
// kind: the stated wait, and whether the provider already spent retries of its
// own on this failure.
func TestClassifyFailureCarriesTheProvidersNumbers(t *testing.T) {
	if got := ClassifyFailure(&RateLimitedError{RetryAfter: 90 * time.Second}); got.RetryAfter != 90*time.Second {
		t.Errorf("rate limited RetryAfter = %v, want 1m30s", got.RetryAfter)
	}
	if got := ClassifyFailure(&APIError{Status: 503, RetryAfter: 7 * time.Second}); got.RetryAfter != 7*time.Second || got.Status != 503 {
		t.Errorf("APIError = %+v, want RetryAfter 7s, Status 503", got)
	}
	retried := &FailureError{Failure: Failure{Kind: FailureOverloaded, ProviderRetried: true}, Message: "ladder exhausted"}
	if got := ClassifyFailure(fmt.Errorf("wrapped: %w", retried)); got.Kind != FailureOverloaded || !got.ProviderRetried {
		t.Errorf("declared = %+v, want Overloaded with ProviderRetried", got)
	}
	if got := ClassifyFailure(fmt.Errorf("x: %w", io.ErrUnexpectedEOF)); got.Status != 0 || got.RetryAfter != 0 {
		t.Errorf("transport failure invented numbers: %+v", got)
	}
}

// TestFailureKindTransient pins which kinds a fresh attempt can clear. Unknown
// is deliberately not among them: the retry policy gives it one attempt of its
// own, but nothing should mistake it for a recognised transient.
func TestFailureKindTransient(t *testing.T) {
	transient := map[FailureKind]bool{
		FailureRateLimited: true, FailureOverloaded: true, FailureServerError: true,
		FailureConnectionDropped: true, FailureStalled: true, FailureTruncated: true,
		FailureUnreachable: true, FailureUnusableOutput: true,
	}
	for k := FailureNone; k <= failureKindLast; k++ {
		if got := k.Transient(); got != transient[k] {
			t.Errorf("%v.Transient() = %v, want %v", k, got, transient[k])
		}
		if k.String() == "" || k.String() == fmt.Sprintf("FailureKind(%d)", int(k)) {
			t.Errorf("FailureKind(%d) has no name", int(k))
		}
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }
