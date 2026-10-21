//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// editRoles are the Wails roles whose accelerators are the webview's own
// editing keys (Ctrl+Z/Y/X/C/V/A, Backspace).
var editRoles = map[application.Role]bool{
	application.EditMenu: true, application.Undo: true, application.Redo: true,
	application.Cut: true, application.Copy: true, application.Paste: true,
	application.PasteAndMatchStyle: true, application.Delete: true,
	application.SelectAll: true,
}

func findEditRole(nodes []menuNode) (application.Role, bool) {
	for _, n := range nodes {
		if editRoles[n.role] {
			return n.role, true
		}
		if r, ok := findEditRole(n.children); ok {
			return r, true
		}
	}
	return application.NoRole, false
}

// TestWindowsMenuLeavesEditingKeysToTheWebview: on Windows a menu accelerator
// becomes a global key binding that runs alongside WebView2's own handling of
// the key, so an Edit role there pastes, deletes or undoes twice.
func TestWindowsMenuLeavesEditingKeysToTheWebview(t *testing.T) {
	a := &appState{}
	for _, dev := range []bool{false, true} {
		if r, ok := findEditRole(menuSpec(a, dev, "windows")); ok {
			t.Errorf("dev=%v: the Windows menu has edit role %v", dev, r)
		}
	}
	if _, ok := findEditRole(menuSpec(a, false, "darwin")); !ok {
		t.Error("the macOS menu has no Edit menu")
	}
}
