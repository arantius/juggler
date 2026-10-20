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
