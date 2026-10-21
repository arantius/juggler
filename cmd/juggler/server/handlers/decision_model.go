//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
)

// DecisionModelAPI serves writes to the decision model the user chose for tasks
// that want one in place of the cheap model, such as Auto-approve's review of a
// parked tool call.
//
// Reading it is not here. Whether the choice can serve right now depends on the
// live provider list the server holds, so that handler stays in package server.
type DecisionModelAPI struct {
	store *core.DecisionModelStore
}

// NewDecisionModelAPI creates a DecisionModelAPI. A nil store makes the route
// report the feature unavailable rather than fail.
func NewDecisionModelAPI(store *core.DecisionModelStore) *DecisionModelAPI {
	return &DecisionModelAPI{store: store}
}

// ChatOnlyError reports why providerName cannot be chosen where a model has to
// hold a conversation — a default or cheap model, a generateText call — or nil
// when it can. The pickers already leave decision-only providers out; this is
// the same rule for a caller that goes straight to the API, so a model that
// cannot chat is refused at the choice rather than failing wherever it is next
// used. An unknown provider is not refused here: whether it exists is a
// different question with its own answer at each route.
func ChatOnlyError(providerName string) error {
	if info, found := provider.GetProviderInfo(providerName); found && !info.Chats() {
		return msg.NewError("{provider} only answers decisions and cannot hold a conversation", "provider", providerName)
	}
	return nil
}

// HandleSet persists the decision model.
// Body: {"provider": "...", "model": "..."}. An empty provider and model clears
// the choice, so the cheap model is used again.
//
// A provider that offers no decisions is refused: storing it would be accepted
// and then never used, and the settings row would show a model that does
// nothing.
func (api *DecisionModelAPI) HandleSet(w http.ResponseWriter, r *http.Request) {
	if api.store == nil {
		WriteMessageError(w, r, http.StatusServiceUnavailable, msg.New("Decision model is not available"))
		return
	}
	req, ok := DecodeJSON[core.ModelRef](w, r)
	if !ok {
		return
	}
	if req.Provider != "" || req.Model != "" {
		if req.Provider == "" || req.Model == "" {
			WriteMessageError(w, r, http.StatusBadRequest, msg.New("A decision model needs both a provider and a model"))
			return
		}
		if info, found := provider.GetProviderInfo(req.Provider); !found || !info.Decisions {
			WriteMessageError(w, r, http.StatusBadRequest, msg.New("{provider} does not offer decision models", "provider", req.Provider))
			return
		}
	}
	if err := api.store.Save(req); err != nil {
		WriteMessageError(w, r, http.StatusInternalServerError, msg.New("Couldn't save decision model: {detail}", "detail", err.Error()))
		return
	}
	WriteSuccess(w, r, nil)
}
