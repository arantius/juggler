//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// HarnessHTTPTimeout bounds every harness→server HTTP request. The default
// http client has NO timeout, so a server whose engine main thread has stalled
// (the macOS hidden-WebView CVDisplayLink hazard the architecture guards
// against) — accepting the TCP connection but never writing a reply — blocks
// the calling goroutine FOREVER. In the browser suite's parallel phase that
// goroutine holds a pool lane, so one wedged server starves every other lane
// and the whole suite hangs until the outer `make test` -timeout (15m) fires:
// the "stuck" symptom. The per-test PerTestTimeout watchdog can't rescue it (it
// only dumps a stack; FailNow from another goroutine is unsafe). Bounding each
// request converts an indefinite whole-suite hang into a single loud,
// attributable per-test failure that frees the lane so the run continues.
// 60s matches the per-test budget in the browser suite — a request still
// outstanding past it means the server is wedged, not slow.
const HarnessHTTPTimeout = 60 * time.Second

// PostConnectWindow bounds how long PostJSON retries transport (dial) failures.
// A freshly-spawned server announces its address (JUGGLER_ADDR=) the instant it
// knows its port — which can be a beat before its HTTP listener is actually
// accepting, and on a loaded CI runner that gap is wider. Without a retry, that
// single "connection refused" fails the WHOLE browser suite before any test
// runs (the __list__ POST that gates test discovery goes through here). A
// transport error means the request never reached the server, so re-sending is
// safe; a genuine boot crash still surfaces once this window elapses.
const PostConnectWindow = 10 * time.Second

// PostJSON sends body as a JSON POST to addr+path and returns an error on
// non-2xx.
//
// Transport (dial) errors are retried with a short backoff up to
// PostConnectWindow. A transport error means no request reached the server, so
// re-sending is safe and cannot double-apply. Once a response IS received (any
// status), it stops retrying — a non-2xx is a real server-side result, not a
// transient condition.
//
// The retry is for a server that isn't listening YET. A server that has exited
// will never listen again, so waiting out the window buys nothing and costs
// every remaining test its full 10s — the difference between a dead pool
// failing the run in seconds and grinding through it for minutes. dead, when
// non-nil, says whether the server has exited.
func PostJSON(addr, path string, body any, dead func() bool) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: HarnessHTTPTimeout}
	deadline := time.Now().Add(PostConnectWindow)
	for {
		resp, err := client.Post("http://"+addr+path, "application/json", bytes.NewReader(data))
		if err != nil {
			// Transport failure: the request never landed. Retry until the
			// connect window closes, then surface the last error.
			if time.Now().Before(deadline) && (dead == nil || !dead()) {
				time.Sleep(100 * time.Millisecond)
				continue
			}
			return err
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			return fmt.Errorf("unexpected status %d", resp.StatusCode)
		}
		return nil
	}
}

// PollJSON GET-polls addr+path every 200 ms until 200 OK is returned and the
// response JSON decodes successfully into out, or until timeout elapses. Each
// GET is bounded by the poll budget so a wedged server (one that accepts the
// connection but never replies) can't block past `timeout` — see
// HarnessHTTPTimeout. A server that has exited (dead, when non-nil, says so)
// ends the poll immediately: the answer it owed can no longer arrive, so
// sitting out the full budget only delays the failure that already happened.
func PollJSON(addr, path string, timeout time.Duration, out any, dead func() bool) error {
	client := &http.Client{Timeout: timeout}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if dead != nil && dead() {
			return fmt.Errorf("polling %s: the server exited", path)
		}
		resp, err := client.Get("http://" + addr + path)
		if err == nil {
			if resp.StatusCode == http.StatusOK {
				decErr := json.NewDecoder(resp.Body).Decode(out)
				resp.Body.Close()
				if decErr == nil {
					return nil
				}
			} else {
				resp.Body.Close()
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("timeout polling %s after %s", path, timeout)
}
