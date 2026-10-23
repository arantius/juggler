//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

import "testing"

// TestUnitSuitesRunOnTheirOwnServers pins the split in poolConfig: the `unit:`
// suites go to the unit pool, everything else to the shared one, and no server
// — so no project and no settings.json — belongs to both. A unit suite landing
// on an integration server would go on passing; it would just be reading its
// siblings' conversations and settings again, which is the whole thing the split
// is for, so the routing is checked here rather than trusted.
func TestUnitSuitesRunOnTheirOwnServers(t *testing.T) {
	if testing.Short() {
		t.Skip("no pool in short mode")
	}
	if loadPoolConfig().unitWindows == 0 {
		t.Skip("JUGGLER_TEST_UNIT_WINDOWS=0: the unit suites share the pool by request")
	}
	if unitServerPool == nil {
		t.Fatal("unit windows are configured but no unit pool was started")
	}
	if poolFor("unit:anything") != unitServerPool {
		t.Error("a unit: suite is not routed to the unit pool")
	}
	for _, name := range []string{"integration:anything", "anything-else"} {
		if poolFor(name) != testServerPool {
			t.Errorf("%q is not routed to the shared pool", name)
		}
	}

	owner := map[string]*lanePool{}
	for _, pool := range allPools() {
		for _, s := range pool.entries() {
			for _, key := range []string{"addr " + s.addr, "project " + s.fixture} {
				if p, ok := owner[key]; ok && p != pool {
					t.Errorf("%s serves both pools", key)
				}
				owner[key] = pool
			}
		}
	}
	if unitServerPool.lanes() == 0 {
		t.Error("the unit pool holds no lanes")
	}
}
