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
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server/handlers"
)

const (
	// llmCompleteDefaultTimeout bounds an HTTP-driven out-of-band completion when
	// the caller names no bound of its own. Slightly longer than the auto-namer's
	// own bound to accommodate larger caps.
	llmCompleteDefaultTimeout = 30 * time.Second
	// llmCompleteMinTimeout is the floor for a caller-supplied bound: a request
	// too small to reach the provider is indistinguishable from a broken one.
	llmCompleteMinTimeout = 1 * time.Second
	// llmCompleteMaxTimeout is the ceiling, and the reason the clamp exists. The
	// out-of-band pool is four slots wide and shared server-wide, so an
	// over-patient caller would otherwise hold one against every other micro-task
	// on the machine for as long as it liked.
	llmCompleteMaxTimeout = 60 * time.Second
)

// handleLLMComplete runs a single bounded out-of-band completion over
// QuickComplete. It backs the plugin generateText op and any UI micro-task.
//
// Body: {system?, prompt, model?, maxTokens?, timeoutMs?}. `model` is a union:
//   - omitted / "cheap" → the resolved cheap model (auto-derived from the
//     current default when unpinned); unresolvable ⇒ 400.
//   - "default"         → the resolved default model.
//   - {provider, model, thinking?} → used as-is, validated against the live list.
//
// Response: {text, usage:{inputTokens, outputTokens, cachedTokens}}. maxTokens
// is server-clamped by QuickComplete into a sane [floor, ceiling] band — the
// floor gives a reasoning cheap model room to think, so plugins never starve it
// into an empty reply. timeoutMs is clamped here (see clampCompleteTimeout).
//
// Failures carry a status a caller can act on without reading prose: 429 the
// pool is momentarily saturated, 504 the bound elapsed, 400 the request or the
// model is wrong, 502 everything else — including a reply left empty by the
// output budget running out (emptyReplyError).
func (s *Server) handleLLMComplete(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		System    string          `json:"system"`
		Prompt    string          `json:"prompt"`
		Model     json.RawMessage `json:"model"`
		MaxTokens int64           `json:"maxTokens"`
		TimeoutMs int64           `json:"timeoutMs"`
	}](w, r)
	if !ok {
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("prompt is required"))
		return
	}

	modelRef, err := s.resolveLLMCompleteModel(r.Context(), req.Model)
	if err != nil {
		handlers.WriteErr(w, r, http.StatusBadRequest, err)
		return
	}

	res, err := s.QuickComplete(r.Context(), QuickCompleteRequest{
		Model:  modelRef,
		System: req.System,
		Prompt: req.Prompt,
		// MaxTokens passed through verbatim: QuickComplete is the single authority
		// that clamps the output budget into [floor, ceiling], flooring it so a
		// reasoning cheap model is not starved into an empty reply.
		MaxTokens: req.MaxTokens,
		Timeout:   clampCompleteTimeout(req.TimeoutMs),
	})
	if err == nil {
		err = emptyReplyError(res)
	}
	if err != nil {
		status, reply := completeErrorStatus(err)
		handlers.WriteErr(w, r, status, reply)
		return
	}

	handlers.WriteJSON(w, r, 0, map[string]any{
		"text": res.Text,
		"usage": map[string]any{
			"inputTokens":  res.Usage.InputTokens,
			"outputTokens": res.Usage.OutputTokens,
			"cachedTokens": res.Usage.CachedTokens,
		},
	})
}

// clampCompleteTimeout turns a caller-supplied millisecond bound into the
// wall-clock timeout to run under. Absent or non-positive means "no preference"
// and yields the default; anything else is clamped into
// [llmCompleteMinTimeout, llmCompleteMaxTimeout] rather than rejected, so a
// plugin that asks for something silly still gets its completion.
//
// The ceiling is compared in milliseconds, before the multiply: a large enough
// value would otherwise overflow into a negative Duration, which
// context.WithTimeout treats as already expired — so the most patient possible
// request would be the one that failed instantly.
func clampCompleteTimeout(ms int64) time.Duration {
	if ms <= 0 {
		return llmCompleteDefaultTimeout
	}
	if ms > int64(llmCompleteMaxTimeout/time.Millisecond) {
		return llmCompleteMaxTimeout
	}
	if d := time.Duration(ms) * time.Millisecond; d > llmCompleteMinTimeout {
		return d
	}
	return llmCompleteMinTimeout
}

// completeErrorStatus maps a QuickComplete failure to the status and message the
// client sees.
//
// The status is the contract callers classify on — the message is prose written
// for a human and free to change — so each outcome a caller would respond to
// differently gets its own code: wait a moment and try again (429), the model
// was too slow (504), or stop and go and fix something (502). An unclassified
// failure keeps its own text, since that text is all the user has to tell a dead
// credential from an unreachable host.
func completeErrorStatus(err error) (int, error) {
	switch {
	case errors.Is(err, ErrQuickCompleteBusy):
		return http.StatusTooManyRequests, msg.NewError("Too many concurrent completions, try again")
	case errors.Is(err, ErrQuickCompleteTimeout):
		return http.StatusGatewayTimeout, msg.NewError("The model didn't answer in time")
	default:
		return http.StatusBadGateway, err
	}
}

// emptyReplyError reports a completion that produced no text because the
// output budget ran out first: a reasoning model that spent the whole cap
// thinking. It is a failure, not an empty answer — handed "", a caller cannot
// tell it from a model with nothing to say, and the auto-approve reviewer would
// read it as a considered deny. The remedy is a setting, so it is reported
// under the 502 that means "go and fix something", not as a retryable timeout.
func emptyReplyError(res QuickCompleteResult) error {
	if strings.TrimSpace(res.Text) != "" || res.StopReason != provider.StopReasonMaxTokens {
		return nil
	}
	return msg.NewError("The model ran out of output tokens while reasoning and gave no answer. Lower its reasoning level in Settings → Defaults → Cheap model.")
}

// resolveLLMCompleteModel resolves the request's `model` union to a concrete
// ModelRef, or returns an error saying why it couldn't.
func (s *Server) resolveLLMCompleteModel(ctx context.Context, raw json.RawMessage) (core.ModelRef, error) {
	// Omitted / null ⇒ cheap.
	trimmed := strings.TrimSpace(string(raw))
	if len(raw) == 0 || trimmed == "null" {
		return s.resolveCheapAlias(ctx)
	}

	// String alias: "cheap" | "default".
	var alias string
	if err := json.Unmarshal(raw, &alias); err == nil {
		switch alias {
		case "", "cheap":
			return s.resolveCheapAlias(ctx)
		case "default":
			ref, _ := s.resolveDefaultModel(ctx)
			if ref.Provider == "" || ref.Model == "" {
				return core.ModelRef{}, msg.NewError("no default model available")
			}
			return ref, nil
		default:
			return core.ModelRef{}, msg.NewError("unknown model alias: {alias}", "alias", alias)
		}
	}

	// Explicit {provider, model, thinking?}.
	var obj struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Thinking string `json:"thinking"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil || obj.Provider == "" || obj.Model == "" {
		return core.ModelRef{}, msg.NewError("invalid model: expected \"cheap\", \"default\", or '{provider, model}'")
	}
	if err := handlers.ChatOnlyError(obj.Provider); err != nil {
		return core.ModelRef{}, err
	}
	concrete, ok := s.liveModelMatch(obj.Provider, obj.Model)
	if !ok {
		return core.ModelRef{}, msg.NewError("model not available: {provider}/{model}", "provider", obj.Provider, "model", obj.Model)
	}
	return core.ModelRef{Provider: obj.Provider, Model: concrete, Thinking: obj.Thinking}, nil
}

// resolveCheapAlias resolves the "cheap" alias: the cheap model derived from the
// current default as primary. Unresolvable ⇒ a user-facing error message.
//
// Goes through cheapModelForTask because a request has arrived that wanted to
// run: the 400 reaches whichever caller asked, but the reason it failed is a
// setting, and the person who has to change it may be nowhere near that caller.
func (s *Server) resolveCheapAlias(ctx context.Context) (core.ModelRef, error) {
	primary, _ := s.resolveDefaultModel(ctx)
	ref, ok := s.cheapModelForTask(ctx, primary)
	if !ok {
		return core.ModelRef{}, msg.NewError("no cheap model available")
	}
	return ref, nil
}
