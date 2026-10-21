//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"testing"

	"juggler/cmd/juggler/core"
)

// A window opens wearing what it inherits. These pin the order the two sources
// are consulted in, because getting it wrong is invisible until a relaunch: the
// window comes up in someone else's theme and only corrects itself a frame
// later, if at all.

func TestStartupPrefsPreferTheOpenersHandOff(t *testing.T) {
	theme, mode, zoom := startupPrefs(windowOpts{theme: "light", mode: "system", zoom: 120}, "dark", 100)
	if theme != "light" || mode != "system" || zoom != 120 {
		t.Fatalf("inherited hand-off = %q/%q/%d, want \"light\"/\"system\"/120", theme, mode, zoom)
	}
}

func TestStartupPrefsFallBackToTheAppsLast(t *testing.T) {
	// No opener (Finder, restore): the freshest values any window reported.
	theme, mode, zoom := startupPrefs(windowOpts{}, "dark", 110)
	if theme != "dark" || zoom != 110 {
		t.Fatalf("a launch with no opener = %q/%d, want \"dark\"/110", theme, zoom)
	}
	// The app remembers a painted colour, not the user's selection, so it names
	// no mode: the page reads that from the machine's settings itself.
	if mode != "" {
		t.Fatalf("mode = %q, want empty", mode)
	}
}

// A first-ever launch says nothing, so the page is free to follow the OS and
// open at the default size.
func TestStartupPrefsSayNothingWhenNothingIsKnown(t *testing.T) {
	theme, mode, zoom := startupPrefs(windowOpts{}, "", 0)
	if theme != "" || mode != "" || zoom != 0 {
		t.Fatalf("a launch with nothing to go on = %q/%q/%d, want empty", theme, mode, zoom)
	}
}

// The app names a window's role from the options it opened it with; the server
// names the same window from the URL it is serving (core.WindowRoleForView).
// Disagree and a board writes its geometry and preferences into one slot and
// reads them back from another.
func TestRolesAgreeWithTheServers(t *testing.T) {
	cases := []windowOpts{
		{},
		{view: viewPinboard, board: "board_one"},
		{view: viewPinboard, board: core.MainBoardID},
		{view: viewPinboard},
		{view: "something-else", board: "board_one"},
	}
	for _, opts := range cases {
		// windowOptsFromQuery is what a real window's options come through, so the
		// board id is already normalised by the time role() sees it.
		got := opts.role()
		want := core.WindowRoleForView(opts.view, opts.board)
		if got != want {
			t.Errorf("view=%q board=%q: app says %q, server says %q", opts.view, opts.board, got, want)
		}
	}
}
