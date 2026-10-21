//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"testing"
)

// A window's slot holds its frame and the UI preferences the viewer keeps for
// it. These pin how the two share it: none of the preferences is lost by the
// geometry write that lands every time a window is dragged, and a slot holding
// only preferences is not mistaken for a frame.

// The frame is captured from the live native window, which knows nothing about
// the viewer's preferences, and it is written on every move and resize.
// Dragging a window must not therefore strip the UI preferences the viewer keeps
// in the same slot.
func TestGeometryWritesKeepTheWindowsUIPrefs(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	if err := m.MergeWindowUIPrefs(board, uiPatch(t, `{"juggler-column-width":"31.5"}`)); err != nil {
		t.Fatalf("set ui prefs: %v", err)
	}
	frame := WindowState{X: 1420, Y: 40, Width: 520, Height: 900, HasPos: true}
	if err := m.SetWindowState(board, frame); err != nil {
		t.Fatalf("SetWindowState: %v", err)
	}

	got, ok := m.GetWindowState(board)
	if !ok {
		t.Fatal("expected the board's slot after a geometry write")
	}
	if !got.SameFrame(frame) {
		t.Fatalf("the frame has to be the one written: got %+v want %+v", got, frame)
	}
	if want := `"31.5"`; string(m.GetWindowUIPrefs(board)["juggler-column-width"]) != want {
		t.Fatalf("a drag wiped the window's UI preferences: got %s want %s",
			m.GetWindowUIPrefs(board)["juggler-column-width"], want)
	}
}

// A window told only a UI preference has a slot with no frame in it. That must
// read as "no saved geometry" — the window is placed by the centred default, not
// at 0,0.
func TestAPrefsOnlySlotIsNotGeometry(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	if err := m.MergeWindowUIPrefs(board, uiPatch(t, `{"juggler-column-width":"31.5"}`)); err != nil {
		t.Fatalf("set ui prefs: %v", err)
	}
	got, _ := m.GetWindowState(board)
	if got.HasPos || got.Width != 0 || got.Height != 0 {
		t.Fatalf("a preferences-only slot must carry no frame: got %+v", got)
	}
}

// The desktop app names a window's role from the options it opened it with, and
// the server names the same window from the URL it is serving. They have to
// agree, or a board would write its geometry and preferences into one slot and
// read them from another. cmd/juggler-app's TestWindowOptsRole pins the other
// side of this.
func TestWindowRoleForView(t *testing.T) {
	cases := []struct {
		name  string
		view  string
		board string
		want  string
	}{
		{"an ordinary window", "", "", WindowRoleMain},
		{"an unknown view is still the app", "something", "board_a", WindowRoleMain},
		{"a detached board", WindowViewPinboard, "board_a", WindowRolePinboardFor("board_a")},
		{"the docked board detached", WindowViewPinboard, MainBoardID, WindowRolePinboardFor(MainBoardID)},
		{"a board with no id", WindowViewPinboard, "", WindowRolePinboard},
		{"a board with an unusable id", WindowViewPinboard, "../etc", WindowRolePinboard},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := WindowRoleForView(c.view, c.board); got != c.want {
				t.Fatalf("WindowRoleForView(%q, %q) = %q, want %q", c.view, c.board, got, c.want)
			}
		})
	}
}
