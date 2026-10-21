//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package windowstate holds the stored state of one native window. It sits
// below both its owner (the session, cmd/juggler/core, which persists it) and
// the window-geometry code (internal/windowgeom, shared by the two Wails
// hosts), so neither has to import the other for the type.
package windowstate

import (
	"encoding/json"
	"maps"
)

// State is one of a project's windows: the native geometry it was left in, and
// the viewer preferences it was left with. It is session state (persisted in
// .juggler/session.json, where core knows it as core.WindowState) rather than a
// single machine-global file: keying it by project gives each project's windows
// their own slots with no cross-process write race, and reopening a project
// restores its windows as they were. Process-local; deliberately NOT part of
// the session's Metadata, so it is never sent to viewers or surfaced as a
// frontend flag.
//
// UI sits beside the frame because it is the same kind of fact about the same
// window, one level less structured: the preferences the viewer keeps for this
// window (see core's ui_prefs.go). Nothing in Go reads them, so they are stored
// opaquely.
//
// Geometry writes never carry them: the frame is captured from the live native
// window (see windowgeom.Tracker.Capture) and knows nothing about the viewer's
// preferences, so the session's SetWindowState preserves whatever is already
// stored.
type State struct {
	X          int                        `json:"x"`
	Y          int                        `json:"y"`
	Width      int                        `json:"width"`
	Height     int                        `json:"height"`
	HasPos     bool                       `json:"hasPos"`
	Maximised  bool                       `json:"maximised"`
	Fullscreen bool                       `json:"fullscreen"`
	UI         map[string]json.RawMessage `json:"ui,omitempty"` // This window's UI preferences, stored verbatim (the client owns the shape); nil until one is set
}

// Clone returns a private copy of one window's slot. The UI map is the reason
// it exists: a map inside a struct value is copied by reference, so a caller
// handed the struct would share that map with whoever else holds a copy. The
// values are immutable bytes, so copying the map is a genuine copy; nil stays
// nil, so an untouched slot serialises without it.
func (ws State) Clone() State {
	ws.UI = maps.Clone(ws.UI)
	return ws
}

// SameFrame reports whether two slots describe the same native window frame,
// ignoring everything that is not geometry.
//
// It exists because State holds a map and so cannot be compared with ==. That
// is the useful outcome rather than an obstacle: almost every comparison is
// asking about the frame, and one that silently started including the viewer's
// preferences would answer a question nobody asked.
func (ws State) SameFrame(other State) bool {
	return ws.X == other.X && ws.Y == other.Y &&
		ws.Width == other.Width && ws.Height == other.Height &&
		ws.HasPos == other.HasPos &&
		ws.Maximised == other.Maximised && ws.Fullscreen == other.Fullscreen
}
