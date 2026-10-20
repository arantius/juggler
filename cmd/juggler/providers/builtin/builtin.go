//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package builtin is the one list of the model providers Juggler ships. The
// server registers all of them at startup (app.registerProviders) and the
// catalog audit (providers/audit) those with a static catalog, so a provider
// added here reaches both, and TestAllCoversEveryProviderPackage fails for one
// that is not.
package builtin

import (
	"juggler/cmd/juggler/providers/acp"
	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/claudecode"
	"juggler/cmd/juggler/providers/copilot"
	"juggler/cmd/juggler/providers/deepseek"
	"juggler/cmd/juggler/providers/gemini"
	"juggler/cmd/juggler/providers/jev"
	"juggler/cmd/juggler/providers/llamacpp"
	"juggler/cmd/juggler/providers/lmstudio"
	"juggler/cmd/juggler/providers/localai"
	"juggler/cmd/juggler/providers/mistral"
	"juggler/cmd/juggler/providers/moonshot"
	"juggler/cmd/juggler/providers/ollama"
	"juggler/cmd/juggler/providers/openai"
	"juggler/cmd/juggler/providers/openaicodex"
	"juggler/cmd/juggler/providers/opencodezen"
	"juggler/cmd/juggler/providers/openrouter"
	"juggler/cmd/juggler/providers/zai"
)

// Provider is one built-in provider.
type Provider struct {
	// Register adds it to the global provider registry.
	Register func()
	// Catalog says it ships a static model catalog of its own, which the
	// catalog audit holds to account. The CLI- and protocol-backed providers
	// do not: their models come from a subprocess.
	Catalog bool
}

// All is every built-in provider, in registration order.
var All = []Provider{
	{acp.Register, false},
	{anthropic.Register, true},
	{claudecode.Register, false},
	{copilot.Register, true},
	{deepseek.Register, true},
	{gemini.Register, true},
	{jev.Register, true},
	{llamacpp.Register, true},
	{lmstudio.Register, true},
	{localai.Register, true},
	{mistral.Register, true},
	{moonshot.Register, true},
	{ollama.Register, true},
	{openai.Register, true},
	{openaicodex.Register, true},
	{opencodezen.Register, true},
	{openrouter.Register, true},
	{zai.Register, true},
}

// Register registers every built-in provider with the global registry.
func Register() {
	for _, p := range All {
		p.Register()
	}
}
