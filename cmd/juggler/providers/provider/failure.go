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
	"net/http"
	"strings"
	"syscall"
	"time"
)

// FailureKind names what went wrong with a provider call, in the terms that
// decide what to do about it. Every failed call is classified into exactly one
// kind (ClassifyFailure), and the worker's retry policy is a table keyed by it,
// so the judgement "is this worth another attempt" is made once, here, rather
// than by each caller matching on whatever words its provider chose.
//
// The kinds are grouped by remedy, not by origin: a 503 and an Anthropic
// overloaded_error event are the same kind because the same thing helps both.
type FailureKind int

const (
	// FailureNone is the classification of a nil error.
	FailureNone FailureKind = iota

	// FailureUnknown is a failure nothing here recognises. It is neither
	// transient nor terminal by nature; the retry policy decides what an
	// unrecognised shape is worth.
	FailureUnknown

	// FailureCancelled is the caller cancelling the call. Never retried, and
	// never reported as an error: it is what the user asked for.
	FailureCancelled

	// FailureRateLimited is a 429 or its equivalent: retry after the stated
	// wait, which RetryAfter carries when the provider gave one.
	FailureRateLimited

	// FailureOverloaded is the provider saying it has no capacity right now
	// (503, 529, overloaded_error). Retried with a backoff long enough to let
	// the capacity return.
	FailureOverloaded

	// FailureServerError is the provider failing on its own side (500, 502,
	// 504, api_error, server_error) for a request that was itself fine.
	FailureServerError

	// FailureConnectionDropped is the connection ending mid-request: an
	// unexpected EOF, a reset, a broken pipe, the server resetting the HTTP/2
	// stream or sending GOAWAY.
	FailureConnectionDropped

	// FailureStalled is the stream going silent until something gave up on
	// it: the provider's idle watchdog, or a network timeout.
	FailureStalled

	// FailureTruncated is a stream that ended cleanly but before the provider
	// said the response was complete — the body simply stopped.
	FailureTruncated

	// FailureUnreachable is a request that never reached the provider: a
	// refused connection, a failed DNS lookup, no route. Usually the network
	// is down or a local server is not running.
	FailureUnreachable

	// FailureUnusableOutput is a response that arrived but could not be acted
	// on (see UnusableOutputError); another sample usually can be.
	FailureUnusableOutput

	// FailureContextOverflow is a request too large for the model's window.
	// The worker's compaction ladder handles it, not the retry loop.
	FailureContextOverflow

	// FailureAuth is a credential the provider will not accept.
	FailureAuth

	// FailureSetup is a provider that cannot run on this machine as it stands.
	FailureSetup

	// FailureQuotaExhausted is an account out of credit or quota — distinct
	// from a rate limit, because waiting does not end it.
	FailureQuotaExhausted

	// FailureInvalidRequest is the provider rejecting the request itself
	// (400, 404, 422, an unknown model). Sending it again changes nothing.
	FailureInvalidRequest

	// FailureRefused is the provider declining to answer on content grounds:
	// a safety filter or content policy.
	FailureRefused

	// FailureCertificate is a TLS certificate that could not be verified. It
	// is a transport failure that retrying cannot fix: something between here
	// and the provider (a proxy, a captive portal, a clock) needs a human.
	FailureCertificate

	failureKindLast = FailureCertificate
)

var failureKindNames = [...]string{
	FailureNone:              "none",
	FailureUnknown:           "unknown",
	FailureCancelled:         "cancelled",
	FailureRateLimited:       "rate-limited",
	FailureOverloaded:        "overloaded",
	FailureServerError:       "server-error",
	FailureConnectionDropped: "connection-dropped",
	FailureStalled:           "stalled",
	FailureTruncated:         "truncated",
	FailureUnreachable:       "unreachable",
	FailureUnusableOutput:    "unusable-output",
	FailureContextOverflow:   "context-overflow",
	FailureAuth:              "auth",
	FailureSetup:             "setup",
	FailureQuotaExhausted:    "quota-exhausted",
	FailureInvalidRequest:    "invalid-request",
	FailureRefused:           "refused",
	FailureCertificate:       "certificate",
}

// String is the kind's stable name, used in logs and as the errorKind an error
// item carries.
func (k FailureKind) String() string {
	if k >= 0 && int(k) < len(failureKindNames) && failureKindNames[k] != "" {
		return failureKindNames[k]
	}
	return fmt.Sprintf("FailureKind(%d)", int(k))
}

// Transient reports whether a fresh attempt at the same request can be expected
// to succeed where this one failed. FailureUnknown is not transient: nothing is
// known about it, and the retry policy, not this method, decides what that is
// worth.
func (k FailureKind) Transient() bool {
	switch k {
	case FailureRateLimited, FailureOverloaded, FailureServerError,
		FailureConnectionDropped, FailureStalled, FailureTruncated,
		FailureUnreachable, FailureUnusableOutput:
		return true
	}
	return false
}

// Failure is a classified provider failure: its kind and the numbers the
// provider supplied with it.
type Failure struct {
	Kind FailureKind

	// Status is the HTTP status the provider answered with, or 0 when there
	// was none (a transport failure, an in-band stream error).
	Status int

	// RetryAfter is how long the provider said to wait, or 0 when it said
	// nothing. 0 means "unstated", never "retry immediately".
	RetryAfter time.Duration

	// ProviderRetried is set when the provider already spent retries of its
	// own on this failure before reporting it. Retrying the turn on top would
	// multiply attempts the provider has judged hopeless.
	ProviderRetried bool
}

// FailureDeclarer is implemented by an error whose provider has classified it
// itself, because it knows something the error's type or text cannot show —
// that its watchdog fired, that a stream ended without its terminal event, that
// it already retried. ClassifyFailure trusts the declaration over anything the
// error wraps. FailureError is the ready-made one; a provider whose errors
// carry state of their own implements the method on its own type.
type FailureDeclarer interface {
	DeclaredFailure() Failure
}

// FailureError is a FailureDeclarer for a provider with no error type of its
// own to declare on.
type FailureError struct {
	Failure
	Message string
	Cause   error
}

// NewFailureError builds a FailureError of the given kind.
func NewFailureError(kind FailureKind, message string, cause error) *FailureError {
	return &FailureError{Failure: Failure{Kind: kind}, Message: message, Cause: cause}
}

// DeclaredFailure is the failure the provider classified this as.
func (e *FailureError) DeclaredFailure() Failure { return e.Failure }

func (e *FailureError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Cause != nil {
		return e.Cause.Error()
	}
	return e.Kind.String()
}

func (e *FailureError) Unwrap() error { return e.Cause }

// APIError is a provider's HTTP or in-band error, reduced to the fields that
// classify it. Each provider maps its SDK's own error type onto this at its
// boundary, so the classifier needs no SDK and every provider is judged by the
// same rules.
type APIError struct {
	// Provider is the registry name of the provider that answered.
	Provider string

	// Status is the HTTP status, or 0 for an error event inside a stream that
	// had already answered 200.
	Status int

	// Type is the provider's own error type or code ("overloaded_error",
	// "server_error", "insufficient_quota"), or "".
	Type string

	// RetryAfter is the wait the provider stated (Retry-After header or body),
	// or 0.
	RetryAfter time.Duration

	// ShouldRetry is the provider's explicit verdict (x-should-retry), or nil
	// when it gave none. When set it overrides the status.
	ShouldRetry *bool

	// Message is the provider's own account, verbatim.
	Message string

	// Cause is the SDK error this was mapped from.
	Cause error
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Cause != nil {
		return e.Cause.Error()
	}
	if e.Status != 0 {
		return fmt.Sprintf("%s returned HTTP %d", e.Provider, e.Status)
	}
	return fmt.Sprintf("%s returned an error (%s)", e.Provider, e.Type)
}

func (e *APIError) Unwrap() error { return e.Cause }

// statusOverloaded is the non-standard status Anthropic and others use for
// "overloaded".
const statusOverloaded = 529

// ClassifyFailure says what kind of failure err is.
//
// The checks run from the most deliberate judgement to the least: a provider's
// own classification (FailureDeclarer), then the typed errors providers raise,
// then the provider's HTTP answer (APIError), then what the standard library
// says about the context and the transport, and last the error's text. Each
// step looks through the whole wrap chain, so a typed error wrapped in prose is
// still found, and an earlier step wins over a later one even when the later
// one's error sits further out.
func ClassifyFailure(err error) Failure {
	if err == nil {
		return Failure{Kind: FailureNone}
	}

	var declared FailureDeclarer
	if errors.As(err, &declared) {
		return declared.DeclaredFailure()
	}
	if f, ok := classifyTyped(err); ok {
		return f
	}
	var api *APIError
	if errors.As(err, &api) {
		return classifyAPIError(api)
	}
	if f, ok := classifyTransport(err); ok {
		return f
	}
	return ClassifyFailureText(err.Error())
}

func classifyTyped(err error) (Failure, bool) {
	var (
		auth     *AuthError
		setup    *SetupError
		limited  *RateLimitedError
		unusable *UnusableOutputError
		overflow *ContextLimitExceededError
		advisory *ContextCompactionAdvisory
		unknown  *UnknownContextLimitError
		reserve  *InvalidOutputReserveError
		tooLarge *DecisionTooLargeError
	)
	switch {
	case errors.As(err, &auth):
		return Failure{Kind: FailureAuth, Status: auth.Status}, true
	case errors.As(err, &setup):
		return Failure{Kind: FailureSetup}, true
	case errors.As(err, &limited):
		return Failure{Kind: FailureRateLimited, Status: http.StatusTooManyRequests, RetryAfter: limited.RetryAfter}, true
	case errors.As(err, &unusable):
		return Failure{Kind: FailureUnusableOutput}, true
	case errors.As(err, &overflow), errors.As(err, &advisory):
		return Failure{Kind: FailureContextOverflow}, true
	case errors.As(err, &unknown), errors.As(err, &reserve), errors.As(err, &tooLarge):
		return Failure{Kind: FailureInvalidRequest}, true
	}
	return Failure{}, false
}

func classifyAPIError(e *APIError) Failure {
	f := Failure{Kind: apiErrorKind(e), Status: e.Status, RetryAfter: e.RetryAfter}
	if e.ShouldRetry != nil {
		switch {
		case *e.ShouldRetry && !f.Kind.Transient():
			f.Kind = FailureServerError
		case !*e.ShouldRetry && f.Kind.Transient():
			f.Kind = FailureInvalidRequest
		}
	}
	return f
}

func apiErrorKind(e *APIError) FailureKind {
	// The type is more specific than the status where both are present — a 429
	// whose type says the quota is gone will not end by waiting — except for
	// the generic server types, which a 5xx says better (OpenAI labels a 503
	// "server_error").
	if k := apiTypeKind(e.Type); k != FailureUnknown && (k != FailureServerError || e.Status < 500) {
		return k
	}
	switch s := e.Status; {
	case s == http.StatusServiceUnavailable || s == statusOverloaded:
		return FailureOverloaded
	case s >= 500:
		return FailureServerError
	case s == http.StatusTooManyRequests:
		return FailureRateLimited
	case s == http.StatusRequestTimeout || s == http.StatusConflict:
		return FailureServerError
	case s == http.StatusPaymentRequired:
		return FailureQuotaExhausted
	case s == http.StatusUnauthorized || s == http.StatusForbidden:
		return FailureAuth
	case s >= 400:
		return FailureInvalidRequest
	}
	// No status and no recognised type: an in-band error whose only content
	// is its message.
	if k := ClassifyFailureText(e.Message).Kind; k != FailureNone {
		return k
	}
	return FailureUnknown
}

// apiTypeKind maps the error types the providers put in their bodies and
// stream error events.
func apiTypeKind(t string) FailureKind {
	switch strings.ToLower(t) {
	case "":
		return FailureUnknown
	case "overloaded_error", "service_unavailable_error", "server_is_overloaded", "unavailable", "resource_exhausted_capacity":
		return FailureOverloaded
	case "api_error", "server_error", "internal_error", "internal_server_error", "internal", "timeout_error":
		return FailureServerError
	case "rate_limit_error", "rate_limit_exceeded", "rate_limited":
		return FailureRateLimited
	case "insufficient_quota", "billing_error", "quota_exceeded", "billing_not_active", "insufficient_credits":
		return FailureQuotaExhausted
	case "authentication_error", "permission_error", "invalid_api_key", "unauthenticated", "permission_denied":
		return FailureAuth
	case "invalid_request_error", "not_found_error", "request_too_large", "invalid_argument", "not_found", "model_not_found":
		return FailureInvalidRequest
	case "content_filter", "content_policy_violation", "safety":
		return FailureRefused
	}
	return FailureUnknown
}

func classifyTransport(err error) (Failure, bool) {
	switch {
	case errors.Is(err, context.Canceled):
		return Failure{Kind: FailureCancelled}, true
	case errors.Is(err, context.DeadlineExceeded):
		return Failure{Kind: FailureStalled}, true
	}

	var (
		unknownAuthority x509.UnknownAuthorityError
		invalidCert      x509.CertificateInvalidError
		hostname         x509.HostnameError
		verification     *tls.CertificateVerificationError
	)
	if errors.As(err, &unknownAuthority) || errors.As(err, &invalidCert) ||
		errors.As(err, &hostname) || errors.As(err, &verification) {
		return Failure{Kind: FailureCertificate}, true
	}

	// A failure to connect at all, before any byte was exchanged. Checked
	// before the errno tests, because a refused dial wraps ECONNREFUSED in an
	// OpError whose Op says it was the dial.
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return Failure{Kind: FailureUnreachable}, true
	}
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "dial" {
		return Failure{Kind: FailureUnreachable}, true
	}
	switch {
	case errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return Failure{Kind: FailureUnreachable}, true
	case errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF),
		errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE), errors.Is(err, syscall.ECONNABORTED):
		// A provider consumes the EOF that ends a complete stream itself, so
		// one that reaches here ended the body early.
		return Failure{Kind: FailureConnectionDropped}, true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return Failure{Kind: FailureStalled}, true
	}
	return Failure{}, false
}

// StallMarker and StallDroppedMarker are the two substrings every provider's
// idle-stall error carries (providers/utils.StallError builds it), so a stall
// that reaches the worker as text alone is still recognised.
const (
	StallMarker        = "stream stalled"
	StallDroppedMarker = "connection may have dropped"
)

// textRule maps lowercase substrings to a kind. The rules are tried in order and
// the first match wins, so a more specific rule must precede a broader one that
// would also match (quota before rate limit, since an out-of-quota body is often
// a 429).
type textRule struct {
	kind    FailureKind
	markers []string
}

// textRules is deliberately narrow. Bare status numbers are not matched — "503"
// appears in token counts, ids, and file paths — with the one long-standing
// exception of "429", which every provider's rate-limit text carries and which
// the worker's error annotations are worded to avoid spelling. Nor is any
// message whose meaning is ambiguous ("exited unexpectedly", "try again
// later"): those stay unknown, and the retry policy decides what an unknown is
// worth.
var textRules = []textRule{
	{FailureQuotaExhausted, []string{"insufficient_quota", "credit balance is too low", "out of credits", "insufficient balance", "billing_error", "no resource package"}},
	{FailureRateLimited, []string{"429", "rate limit", "rate_limit", "too many requests"}},
	{FailureAuth, []string{"authentication_error", "invalid x-api-key", "invalid api key", "invalid_api_key", "unauthorized"}},
	{FailureRefused, []string{"safety filter", "content_filter", "content policy", "content_policy"}},
	// The transport before the server: an HTTP/2 reset from the peer names its
	// code ("INTERNAL_ERROR"), which would otherwise read as a server error.
	{FailureConnectionDropped, []string{"; received from peer", "server sent goaway", "unexpected eof", "connection reset", "broken pipe", "connection aborted"}},
	{FailureStalled, []string{StallMarker, StallDroppedMarker, "i/o timeout", "tls handshake timeout", "timeout awaiting response headers"}},
	{FailureUnreachable, []string{"connection refused", "no such host", "no route to host", "network is unreachable"}},
	{FailureOverloaded, []string{"overloaded", "service unavailable", "service_unavailable", "temporarily unavailable"}},
	{FailureServerError, []string{"internal server error", "bad gateway", "gateway timeout", "api_error", "server_error", "internal_error"}},
	{FailureInvalidRequest, []string{"invalid_request_error", "invalid request", "not_found_error"}},
}

// ClassifyFailureText classifies a failure known only by its text — a wire or
// scripted response's error string, or a CLI's result message. In-process
// callers holding the error itself use ClassifyFailure, which reads its types
// first and falls back to this.
func ClassifyFailureText(msg string) Failure {
	if msg == "" {
		return Failure{Kind: FailureNone}
	}
	lower := strings.ToLower(msg)
	for _, rule := range textRules {
		for _, marker := range rule.markers {
			if strings.Contains(lower, marker) {
				return Failure{Kind: rule.kind}
			}
		}
	}
	return Failure{Kind: FailureUnknown}
}
