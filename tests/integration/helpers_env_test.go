//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"reflect"
	"testing"

	"juggler/tests/helpers"
)

func TestEnvWithOverride(t *testing.T) {
	t.Parallel()

	got := helpers.EnvWithOverride([]string{
		"HOME=/tmp/home",
		"JUGGLER_CONFIG_DIR=/real/profile",
		"PATH=/bin",
		"JUGGLER_CONFIG_DIR=/other/profile",
	}, "JUGGLER_CONFIG_DIR", "/tmp/test-profile")
	want := []string{
		"HOME=/tmp/home",
		"PATH=/bin",
		"JUGGLER_CONFIG_DIR=/tmp/test-profile",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("helpers.EnvWithOverride() = %q, want %q", got, want)
	}
}
