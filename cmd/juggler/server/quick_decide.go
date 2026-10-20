//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"fmt"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/osactivity"
	"juggler/cmd/juggler/providers/provider"
)

// QuickDecideRequest is one bounded, out-of-band decision. The caller
// pre-resolves Model to a concrete {provider, model}; only the provider and
// model of it are used, since a decision model has no reasoning level or
// serving tier.
type QuickDecideRequest struct {
	Model   core.ModelRef
	Request provider.DecisionRequest
	Timeout time.Duration // wall-clock bound; 0 ⇒ quickCompleteDefaultTimeout
}

// QuickDecide asks a decision model a set of questions about some text, with no
// tools, no Yjs document, no worker and no persistence — the decision-model
// sibling of QuickComplete. It builds the provider directly, asks once, and
// returns the typed answers.
//
// It runs in the same pool as QuickComplete, with the same guardrails: a
// saturated pool is refused at once with ErrQuickCompleteBusy, and a request
// that outlives its own bound gets ErrQuickCompleteTimeout, so a caller handles
// both kinds of out-of-band work the same way. The request is checked against
// the model's context window by the provider's admission wrapper before it is
// sent. A provider that cannot make decisions is refused here with an error
// naming it, not left to fail inside the client.
func (s *Server) QuickDecide(ctx context.Context, req QuickDecideRequest) (provider.DecisionResult, error) {
	if req.Model.Provider == "" || req.Model.Model == "" {
		return provider.DecisionResult{}, fmt.Errorf("quick decide: model not specified")
	}
	if err := req.Request.Validate(); err != nil {
		return provider.DecisionResult{}, fmt.Errorf("quick decide: %w", err)
	}

	prov, release, err := s.outOfBandProvider(ctx, "quick decide", req.Model)
	if err != nil {
		return provider.DecisionResult{}, err
	}
	defer release()

	if _, ok := provider.As[provider.Decider](prov); !ok {
		return provider.DecisionResult{}, fmt.Errorf("quick decide: provider %q does not make decisions", req.Model.Provider)
	}

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = quickCompleteDefaultTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Keep macOS from App-Napping us mid-request; refcounted + released in defer.
	osactivity.Begin()
	defer osactivity.End()

	result, err := provider.Decide(callCtx, prov, req.Request)
	if err != nil {
		// Classified from the deadline itself, for the reason QuickComplete gives:
		// callCtx is the only reliable witness that OUR bound is what fired.
		if callCtx.Err() == context.DeadlineExceeded && ctx.Err() == nil {
			return provider.DecisionResult{}, ErrQuickCompleteTimeout
		}
		return provider.DecisionResult{}, err
	}
	return result, nil
}
