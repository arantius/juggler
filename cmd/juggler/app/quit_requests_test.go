//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"os"
	"sync/atomic"
	"testing"
	"time"
)

// TestAShutdownRequestIsReportedOnce pins that one request to stop is one
// request. The server signals a shutdown by closing its channel, and a closed
// channel is ready on every receive — read in a loop, it reports the same
// request forever, spinning a core through the whole teardown and filling the
// log with the one line until the process exits, which buries whatever the log
// was holding about why the run was stopped.
func TestAShutdownRequestIsReportedOnce(t *testing.T) {
	shutdown := make(chan struct{})
	serverErr := make(chan error)
	var reports, quits atomic.Int64

	go watchQuitRequests(make(chan os.Signal), serverErr, shutdown,
		func(string) { reports.Add(1) }, func() { quits.Add(1) })

	close(shutdown)
	close(serverErr)
	// Long enough for a spinning loop to report thousands of times; a correct
	// one reports each closed channel once and then waits.
	time.Sleep(200 * time.Millisecond)

	if got := reports.Load(); got != 2 {
		t.Errorf("the closed shutdown and server-exit channels were reported %d times, want 2 (once each)", got)
	}
	if got := quits.Load(); got != 2 {
		t.Errorf("quit was fired %d times, want 2 (once per request)", got)
	}
}
