//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"juggler/internal/apipaths"
)

// TestStandaloneServerServesAnAllowedHostAsRemote stands in for a reverse
// proxy on this machine (tailscale serve) in front of a real per-project
// server started with --allow-host: it connects over loopback and forwards
// the proxy's public name as Host. The page and its API work under that name,
// but the caller is remote — it cannot write this machine's UI preferences or
// take the engine slot — and a name not on the list is still refused.
func TestStandaloneServerServesAnAllowedHostAsRemote(t *testing.T) {
	const allowed = "box.tailnet.example.ts.net"
	addr := startStandaloneServer(t, newProjectDir(t), "--allow-host", allowed)

	do := func(method, path, host, token, body string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, "http://"+addr+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		req.Header.Set("Origin", "https://"+host)
		if token != "" {
			req.Header.Set("X-Juggler-Token", token)
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	code, page := do(http.MethodGet, "/", allowed, "", "")
	m := apiTokenPattern.FindStringSubmatch(page)
	if code != http.StatusOK || m == nil {
		t.Fatalf("GET / with Host %s: status %d, token found %v; want 200 with a token", allowed, code, m != nil)
	}
	token := m[1]

	if code, body := do(http.MethodGet, "/api/health/instance", allowed+":443", token, ""); code != http.StatusOK {
		t.Errorf("GET /api/health/instance with Host %s:443: status %d (%s), want 200", allowed, code, strings.TrimSpace(body))
	}
	if code, body := do(http.MethodPut, "/api/session/ui-prefs", allowed, token, `{"ui":{"juggler-column-width":"31.5"}}`); code != http.StatusForbidden {
		t.Errorf("PUT ui-prefs through the proxy: status %d (%s), want 403 (a remote viewer)", code, strings.TrimSpace(body))
	}
	if code, body := do(http.MethodPut, "/api/session/ui-prefs", addr, token, `{"ui":{"juggler-column-width":"31.5"}}`); code != http.StatusOK {
		t.Errorf("PUT ui-prefs from this machine: status %d (%s), want 200", code, strings.TrimSpace(body))
	}
	if code, _ := do(http.MethodGet, "/", "other.tailnet.example.ts.net", "", ""); code != http.StatusForbidden {
		t.Errorf("GET / with an unlisted Host: status %d, want 403", code)
	}

	// The engine slot, asked for with the session's own token so that only
	// where the request came from can be what refuses it.
	dialer := websocket.Dialer{
		NetDial: func(network, _ string) (net.Conn, error) { return net.Dial(network, addr) },
	}
	header := http.Header{"Origin": []string{"https://" + allowed}}
	conn, resp, err := dialer.Dial("ws://"+allowed+apipaths.WebSocket+"?role=engine&token="+url.QueryEscape(token), header)
	assertEngineSlotRefused(t, conn, resp, err, "a caller through the proxy")
}
