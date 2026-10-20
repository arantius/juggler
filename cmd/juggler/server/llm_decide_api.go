//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server/handlers"
)

// handleLLMDecide runs a single bounded out-of-band decision over QuickDecide.
// It backs the plugin decide op, and is to a decision model what
// handleLLMComplete is to a chat model.
//
// Body: {state, questions:[{id, kind, instructions, options?}], model?,
// timeoutMs?}. `model` is a union:
//   - omitted / "decision" → the resolved decision model; none chosen, or the
//     chosen one unavailable ⇒ 409, and the caller decides what to do instead.
//   - {provider, model}    → used as-is, validated against the live list and
//     required to be a decision model.
//
// Response: {answers:{<id>:{kind, probability? | choice?+confidence? | score?+
// confidence?, probabilities?}}, usage:{inputTokens, outputTokens}}.
//
// Failures use the statuses handleLLMComplete does, so a caller classifies the
// two alike: 429 the pool is momentarily saturated, 504 the bound elapsed, 400
// the request or the model is wrong, 502 everything else. One status is new:
// 409 means there is no decision model to ask. That is a state of the user's
// settings rather than a fault in the request, so a caller that can do without
// one (Auto-approve falls back to the cheap model) tells it from a 400.
func (s *Server) handleLLMDecide(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		provider.DecisionRequest
		Model     json.RawMessage `json:"model"`
		TimeoutMs int64           `json:"timeoutMs"`
	}](w, r)
	if !ok {
		return
	}
	if err := req.Validate(); err != nil {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("invalid decision request: {detail}", "detail", err.Error()))
		return
	}

	modelRef, err := s.resolveLLMDecideModel(r.Context(), req.Model)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errNoDecisionModel) {
			status = http.StatusConflict
		}
		handlers.WriteErr(w, r, status, err)
		return
	}

	res, err := s.QuickDecide(r.Context(), QuickDecideRequest{
		Model:   modelRef,
		Request: req.DecisionRequest,
		Timeout: clampCompleteTimeout(req.TimeoutMs),
	})
	if err != nil {
		status, reply := completeErrorStatus(err)
		handlers.WriteErr(w, r, status, reply)
		return
	}

	handlers.WriteJSON(w, r, 0, res)
}

// resolveLLMDecideModel resolves the request's `model` union to a concrete
// ModelRef, or returns an error saying why it couldn't.
func (s *Server) resolveLLMDecideModel(ctx context.Context, raw json.RawMessage) (core.ModelRef, error) {
	trimmed := strings.TrimSpace(string(raw))
	if len(raw) == 0 || trimmed == "null" {
		return s.resolveDecisionAlias(ctx)
	}

	var alias string
	if err := json.Unmarshal(raw, &alias); err == nil {
		if alias == "" || alias == "decision" {
			return s.resolveDecisionAlias(ctx)
		}
		return core.ModelRef{}, msg.NewError("unknown model alias: {alias}", "alias", alias)
	}

	var obj struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil || obj.Provider == "" || obj.Model == "" {
		return core.ModelRef{}, msg.NewError("invalid model: expected \"decision\" or '{provider, model}'")
	}
	if info, found := provider.GetProviderInfo(obj.Provider); !found || !info.Decisions {
		return core.ModelRef{}, msg.NewError("{provider} does not offer decision models", "provider", obj.Provider)
	}
	concrete, ok := s.liveModelMatch(obj.Provider, obj.Model)
	if !ok {
		return core.ModelRef{}, msg.NewError("model not available: {provider}/{model}", "provider", obj.Provider, "model", obj.Model)
	}
	return core.ModelRef{Provider: obj.Provider, Model: concrete}, nil
}

// resolveDecisionAlias resolves the "decision" alias: the decision model the
// user chose in Settings. Unresolvable ⇒ a user-facing error message.
func (s *Server) resolveDecisionAlias(ctx context.Context) (core.ModelRef, error) {
	ref, ok := s.resolveDecisionModel(ctx)
	if !ok {
		return core.ModelRef{}, errNoDecisionModel
	}
	return ref, nil
}
