//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
)

// ModelPreferencesAPI serves the user's model choices that outlive a
// conversation: the default model new conversations are seeded with, the
// cheap-model pin, and the recently-used list.
//
// Reading the cheap model is not here. When nothing is pinned its GET reports
// the auto-derived sibling of the current default, which comes from the live
// provider list the server holds, so that one handler stays in package server.
type ModelPreferencesAPI struct {
	defaultModels *core.DefaultModelStore
	cheapModels   *core.CheapModelStore
	recentModels  *core.RecentModelsStore
	// resolveDefault answers which model a new conversation gets: the stored
	// default, or one the server derives from the providers available now.
	resolveDefault func(ctx context.Context) (core.ModelRef, bool)
}

// NewModelPreferencesAPI creates a ModelPreferencesAPI. A nil cheap or recent
// store makes its routes report the feature unavailable (or, for the recent
// list's GET, empty) rather than fail.
func NewModelPreferencesAPI(
	defaultModels *core.DefaultModelStore,
	cheapModels *core.CheapModelStore,
	recentModels *core.RecentModelsStore,
	resolveDefault func(ctx context.Context) (core.ModelRef, bool),
) *ModelPreferencesAPI {
	return &ModelPreferencesAPI{
		defaultModels:  defaultModels,
		cheapModels:    cheapModels,
		recentModels:   recentModels,
		resolveDefault: resolveDefault,
	}
}

// HandleGetDefaultModel returns the concrete {provider, model, thinking?} a new
// conversation should be seeded with. When the user has set a default it is
// returned as-is (explicit:true); otherwise the server computes the preferred
// available provider's first model from the live provider list
// (explicit:false). The result is captured onto the conversation at creation
// time, so a later change to the default never retargets an existing
// conversation. `thinking` is included only when non-empty (absent = the
// model's default level), and `serviceTier` likewise (absent = standard
// serving).
func (api *ModelPreferencesAPI) HandleGetDefaultModel(w http.ResponseWriter, r *http.Request) {
	ref, explicit := api.resolveDefault(r.Context())
	body := map[string]any{
		"provider": ref.Provider,
		"model":    ref.Model,
		"explicit": explicit,
	}
	if ref.Thinking != "" {
		body["thinking"] = ref.Thinking
	}
	if ref.ServiceTier != "" {
		body["serviceTier"] = ref.ServiceTier
	}
	WriteJSON(w, r, 0, body)
}

// HandleSetDefaultModel persists the model new conversations are seeded with.
// Body: {"provider": "...", "model": "...", "thinking": "...", "serviceTier": "..."}
// — thinking and serviceTier are optional; absent/empty means the model's
// default level and standard serving respectively. An empty provider/model
// clears the stored value, reverting to automatic selection.
//
// A stored tier is spent money, so it rides only this explicit route: it is
// written into each new conversation's config at seed time, where the user can
// see and change it, and is never applied by the provider on the caller's
// behalf (see openaibase.ServiceTierSpec.tierFor).
func (api *ModelPreferencesAPI) HandleSetDefaultModel(w http.ResponseWriter, r *http.Request) {
	req, ok := DecodeJSON[core.ModelRef](w, r)
	if !ok {
		return
	}
	if err := ChatOnlyError(req.Provider); err != nil {
		WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	if err := api.defaultModels.Save(req); err != nil {
		WriteMessageError(w, r, http.StatusInternalServerError, msg.New("Couldn't save default model: {detail}", "detail", err.Error()))
		return
	}
	WriteSuccess(w, r, nil)
}

// HandleSetCheapModel persists the cheap model used for out-of-band micro-tasks.
// Body: {"provider": "...", "model": "...", "thinking": "...", "serviceTier": "...",
// "disabled": bool} — thinking and serviceTier are optional; absent/empty means
// the model's default level and standard serving respectively. An empty
// provider/model clears the stored value, reverting to Auto; "disabled": true
// records that the user wants no cheap model at all, which is a different
// answer and is stored as one.
func (api *ModelPreferencesAPI) HandleSetCheapModel(w http.ResponseWriter, r *http.Request) {
	if api.cheapModels == nil {
		WriteMessageError(w, r, http.StatusServiceUnavailable, msg.New("Cheap model is not available"))
		return
	}
	req, ok := DecodeJSON[core.CheapModelSetting](w, r)
	if !ok {
		return
	}
	if err := ChatOnlyError(req.Provider); err != nil {
		WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	if err := api.cheapModels.Save(req); err != nil {
		WriteMessageError(w, r, http.StatusInternalServerError, msg.New("Couldn't save cheap model: {detail}", "detail", err.Error()))
		return
	}
	WriteSuccess(w, r, nil)
}

// HandleRecentModels handles the user's recently-used concrete models.
//
//	GET  /api/recent-models           → {"models": [{provider, model, thinking?}, ...]} (most-recent first)
//	POST /api/recent-models {provider, model, thinking?} → records usage, returns {success}
//
// `thinking` is optional on both sides — absent/empty means the model's
// default level, and entries dedupe by the full triple.
//
// The list is server-side (not browser localStorage) so it survives app
// relaunch / a spawned server binding to a different port. Whether a model is
// currently available never affects it — recording a pick is decoupled from
// availability, and the list is returned verbatim.
func (api *ModelPreferencesAPI) HandleRecentModels(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		api.postRecentModel(w, r)
		return
	}
	api.getRecentModels(w, r)
}

func (api *ModelPreferencesAPI) getRecentModels(w http.ResponseWriter, r *http.Request) {
	if api.recentModels == nil {
		WriteJSON(w, r, 0, map[string]any{"models": []core.ModelRef{}})
		return
	}

	models, err := api.recentModels.Load()
	if err != nil {
		WriteMessageError(w, r, http.StatusInternalServerError, msg.New("Couldn't load recent models: {detail}", "detail", err.Error()))
		return
	}
	if models == nil {
		models = []core.ModelRef{}
	}
	WriteJSON(w, r, 0, map[string]any{"models": models})
}

func (api *ModelPreferencesAPI) postRecentModel(w http.ResponseWriter, r *http.Request) {
	if api.recentModels == nil {
		WriteMessageError(w, r, http.StatusServiceUnavailable, msg.New("Recent models are not available"))
		return
	}

	// Both dials are recorded: a recent entry is re-applied verbatim, so one
	// stored without its tier would silently re-select standard serving.
	req, ok := DecodeJSON[core.ModelRef](w, r)
	if !ok {
		return
	}
	if err := api.recentModels.Add(req); err != nil {
		WriteMessageError(w, r, http.StatusInternalServerError, msg.New("Couldn't record recent model: {detail}", "detail", err.Error()))
		return
	}
	WriteSuccess(w, r, nil)
}
