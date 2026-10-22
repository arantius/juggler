//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

const (
	sseMessageStart = `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}`
	sseTextStart    = `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`
	sseTextDelta    = `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Half an ans"}}`
)

// failingReader yields its prefix and then fails, as a body does when the
// connection under it dies mid-stream.
type failingReader struct {
	prefix io.Reader
	err    error
}

func (f *failingReader) Read(p []byte) (int, error) {
	if n, err := f.prefix.Read(p); n > 0 || err != io.EOF {
		return n, err
	}
	return 0, f.err
}

func sseResponse(r *http.Request, body io.Reader) *http.Response {
	header := make(http.Header)
	header.Set("Content-Type", "text/event-stream")
	return &http.Response{StatusCode: http.StatusOK, Header: header, Body: io.NopCloser(body), Request: r}
}

func statusResponse(r *http.Request, status int, header http.Header, body string) *http.Response {
	if header == nil {
		header = make(http.Header)
	}
	header.Set("Content-Type", "application/json")
	return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body)), Request: r}
}

func streamOnce(t *testing.T, c *Client) error {
	t.Helper()
	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	return err
}

// TestStreamFailuresClassify drives each way an Anthropic call fails through
// the real SDK and asserts the kind the worker will see. Each case also counts
// requests: the worker's retry loop owns every retry, so the SDK must make
// exactly one.
func TestStreamFailuresClassify(t *testing.T) {
	tests := []struct {
		name    string
		respond func(*http.Request) *http.Response
		want    provider.FailureKind
	}{
		{
			name: "500 api_error",
			respond: func(r *http.Request) *http.Response {
				return statusResponse(r, 500, nil, `{"type":"error","error":{"type":"api_error","message":"Internal server error"}}`)
			},
			want: provider.FailureServerError,
		},
		{
			name: "529 overloaded",
			respond: func(r *http.Request) *http.Response {
				return statusResponse(r, 529, nil, `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`)
			},
			want: provider.FailureOverloaded,
		},
		{
			name: "400 invalid request",
			respond: func(r *http.Request) *http.Response {
				return statusResponse(r, 400, nil, `{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}`)
			},
			want: provider.FailureInvalidRequest,
		},
		{
			name: "connection drops mid-stream",
			respond: func(r *http.Request) *http.Response {
				return sseResponse(r, &failingReader{
					prefix: strings.NewReader(messageSSE(
						[2]string{"message_start", sseMessageStart},
						[2]string{"content_block_start", sseTextStart},
						[2]string{"content_block_delta", sseTextDelta},
					)),
					err: io.ErrUnexpectedEOF,
				})
			},
			want: provider.FailureConnectionDropped,
		},
		{
			name: "stream ends without message_stop",
			respond: func(r *http.Request) *http.Response {
				return sseResponse(r, strings.NewReader(messageSSE(
					[2]string{"message_start", sseMessageStart},
					[2]string{"content_block_start", sseTextStart},
					[2]string{"content_block_delta", sseTextDelta},
				)))
			},
			want: provider.FailureTruncated,
		},
		{
			name: "overloaded error event mid-stream",
			respond: func(r *http.Request) *http.Response {
				return sseResponse(r, strings.NewReader(messageSSE(
					[2]string{"message_start", sseMessageStart},
					[2]string{"error", `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`},
				)))
			},
			want: provider.FailureOverloaded,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requests := 0
			c := respondingClient(func(r *http.Request) (*http.Response, error) {
				requests++
				return tt.respond(r), nil
			})
			err := streamOnce(t, c)
			if err == nil {
				t.Fatal("streamMessage succeeded")
			}
			if got := provider.ClassifyFailure(err).Kind; got != tt.want {
				t.Fatalf("classified %v, want %v: %v", got, tt.want, err)
			}
			if requests != 1 {
				t.Fatalf("the SDK made %d requests, want 1 — retrying is the worker's job", requests)
			}
		})
	}
}

// TestRateLimitCarriesTheStatedWait: a 429's Retry-After reaches the worker as
// a number, so it can tell a throttle from a cap that lasts hours.
func TestRateLimitCarriesTheStatedWait(t *testing.T) {
	c := respondingClient(func(r *http.Request) (*http.Response, error) {
		return statusResponse(r, 429, http.Header{"Retry-After": {"7"}},
			`{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`), nil
	})
	err := streamOnce(t, c)
	var limited *provider.RateLimitedError
	if !errors.As(err, &limited) || limited.RetryAfter != 7*time.Second {
		t.Fatalf("error = %v, want a RateLimitedError waiting 7s", err)
	}
}

// TestCompleteStreamIsNotTruncated: the end marker is what makes a stream
// complete, and a stream that has it is not a failure.
func TestCompleteStreamIsNotTruncated(t *testing.T) {
	c := streamingClient(messageSSE(
		[2]string{"message_start", sseMessageStart},
		[2]string{"content_block_start", sseTextStart},
		[2]string{"content_block_delta", sseTextDelta},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		[2]string{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`},
		[2]string{"message_stop", `{"type":"message_stop"}`},
	))
	if err := streamOnce(t, c); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
}
