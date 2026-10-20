//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server/handlers"
)

// errNoDecisionModel is why a request for "the decision model" could not be
// served: the user has chosen none, or the one they chose cannot serve right now.
// It is its own value so the endpoint can answer it with a status of its own,
// which a caller falls back from, rather than with the 400 that means the request
// itself was wrong.
var errNoDecisionModel = msg.NewError("no decision model available")

// resolveDecisionModel returns the concrete {provider, model} to use wherever a
// decision model is wanted in place of a chat model, plus whether there is one.
//
// There is exactly one way to have one: the user chose it (decisionModelStore)
// and it can serve right now — its provider offers decisions, is available, and
// still lists the model the user did not hide. Nothing is derived. A decision
// model is a different kind of thing from the chat model it stands in for and is
// billed by a different account, so unlike the cheap model it is never guessed
// from the providers merely sitting configured: a user who has not chosen one
// gets the cheap model, as before decision models existed.
//
// A choice that cannot serve is not an error. The caller falls back to the cheap
// model exactly as it does for no choice, because a stale pin (a key removed, a
// model retired) must not switch off the feature it was meant to improve.
func (s *Server) resolveDecisionModel(ctx context.Context) (core.ModelRef, bool) {
	if s.decisionModelStore == nil {
		return core.ModelRef{}, false
	}
	stored, err := s.decisionModelStore.Load()
	if err != nil || stored.Provider == "" || stored.Model == "" {
		return core.ModelRef{}, false
	}
	// The live provider list drives the availability check, so wait out startup
	// discovery once here (a no-op in steady state), as resolveCheapModel does.
	s.awaitProvidersReady(ctx)

	if info, found := provider.GetProviderInfo(stored.Provider); !found || !info.Decisions {
		return core.ModelRef{}, false
	}
	concrete, ok := s.liveModelMatch(stored.Provider, stored.Model)
	if !ok {
		return core.ModelRef{}, false
	}
	return core.ModelRef{Provider: stored.Provider, Model: concrete}, true
}

// handleDecisionModel returns the decision model chosen for tasks that want one.
//
// `explicit` is whether the user has chosen one, and `provider`/`model` say
// which. `available` is whether that choice can serve right now, which is what a
// caller deciding between this model and the cheap one needs: a choice that is
// stored but cannot serve reports explicit:true, available:false, so the
// settings row can say so instead of silently showing a model that is not used.
// With nothing chosen the body is just {explicit:false}, which the UI shows as
// the cheap model being used.
func (s *Server) handleDecisionModel(w http.ResponseWriter, r *http.Request) {
	var stored core.ModelRef
	if s.decisionModelStore != nil {
		stored, _ = s.decisionModelStore.Load()
	}
	if stored.Provider == "" || stored.Model == "" {
		handlers.WriteJSON(w, r, 0, map[string]any{"explicit": false, "available": false})
		return
	}
	_, available := s.resolveDecisionModel(r.Context())
	handlers.WriteJSON(w, r, 0, map[string]any{
		"explicit":  true,
		"provider":  stored.Provider,
		"model":     stored.Model,
		"available": available,
	})
}
