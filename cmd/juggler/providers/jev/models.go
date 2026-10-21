//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package jev

import "juggler/cmd/juggler/providers/provider"

// ModelContextWindows is the offline answer for Jev's context windows (tokens
// per request). The models endpoint lists names, descriptions and release dates
// but no limits, so this catalogue is the only source of a window; the live list
// decides which models exist and this decides how large each one is.
//
// Both the version and the alias that resolves to it are listed, since either
// can be the id a decision was configured with.
// Source: https://docs.typesafe.ai/models
var ModelContextWindows = map[string]int{
	"jev-1.14.0":  64000,
	"jev-preview": 64000,
	"jev-1.13.0":  64000,
	"jev-latest":  64000,
}

// DefaultContextWindow is used for a Jev model the catalogue does not name. It
// matches every published model: the endpoint serves 64k per request unless the
// long-context header is sent, which this client never does.
const DefaultContextWindow = 64000

// QuestionContextWindow is the per-question limit every published model shares:
// the state plus any one question must fit it, as well as the whole request
// fitting the context window. Like the window, it is the figure without the
// long-context header.
const QuestionContextWindow = 32000

// contextWindow returns a model's window and whether the number is a catalogued
// figure rather than the fallback.
func contextWindow(model string) (window int, catalogued bool) {
	if window, ok := ModelContextWindows[model]; ok {
		return window, true
	}
	return DefaultContextWindow, false
}

// resolveCapabilities supplies admission with the window and per-question limit
// of a catalogued model. An unknown id reports false so it fails closed, the
// same as every provider's.
func resolveCapabilities(model string) (provider.ModelCapabilities, bool) {
	window, ok := ModelContextWindows[model]
	if !ok {
		return provider.ModelCapabilities{}, false
	}
	return provider.ModelCapabilities{ContextWindowTokens: int64(window), QuestionContextTokens: QuestionContextWindow}, true
}
