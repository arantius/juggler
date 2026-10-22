//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"math/rand/v2"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
)

// retryRule is what the turn loop does about one kind of provider failure.
type retryRule struct {
	// attempts is how many calls a sequence failing this way may make in
	// total, the first included. 1 would mean "never retried"; a kind that is
	// never retried has no rule at all.
	attempts int

	// base is the wait before the first retry, doubled for each one after,
	// up to ceiling. A wait the provider stated replaces it.
	base, ceiling time.Duration

	// status is the "retrying" label shown while the loop waits.
	status func(attempt, max int, spent time.Duration) msg.Message
}

// defaultRetryBackoffLimit is the longest any computed backoff waits — the
// largest ceiling in retryRuleFor — and what a worker's retryBackoffLimit
// starts as. A wait the provider stated is not subject to it.
const defaultRetryBackoffLimit = 30 * time.Second

// retryRuleFor is the whole of the turn loop's retry behaviour, one rule per
// failure kind that a fresh attempt can clear. A kind with no rule (ok false) is
// terminal: it is reported as it stands, or handled by its own path — a context
// overflow by compaction, an auth or setup failure as a user-fixable notice.
//
// The waits are sized to the failure. A dropped connection or a stall is
// usually gone the moment a new one is opened, so it is retried quickly. An
// overloaded or failing server needs time to recover, so it backs off
// further, and gets one more attempt since each is cheap against a fast
// refusal. An unrecognised failure gets a single attempt: enough to ride out a
// shape nobody has seen yet, not enough to hammer a provider about a real bug.
//
// Every sequence is also bounded by MaxLLMRetryWindow, whatever its rule says.
func retryRuleFor(kind provider.FailureKind) (retryRule, bool) {
	switch kind {
	case provider.FailureRateLimited:
		return retryRule{attempts: MaxLLMRetries, base: defaultRetryWait, ceiling: defaultRetryWait, status: rateLimitedStatus}, true
	case provider.FailureOverloaded:
		return retryRule{attempts: 4, base: 2 * time.Second, ceiling: defaultRetryBackoffLimit, status: overloadedStatus}, true
	case provider.FailureServerError:
		return retryRule{attempts: 4, base: 2 * time.Second, ceiling: defaultRetryBackoffLimit, status: serverErrorStatus}, true
	case provider.FailureConnectionDropped, provider.FailureStalled, provider.FailureTruncated:
		return retryRule{attempts: MaxLLMRetries, base: TransientRetryWait, ceiling: 10 * time.Second, status: connectionDroppedStatus}, true
	case provider.FailureUnreachable:
		return retryRule{attempts: MaxLLMRetries, base: 2 * time.Second, ceiling: 10 * time.Second, status: connectionDroppedStatus}, true
	case provider.FailureUnusableOutput:
		return retryRule{attempts: MaxLLMRetries, base: TransientRetryWait, ceiling: TransientRetryWait, status: unusableOutputStatus}, true
	case provider.FailureUnknown:
		return retryRule{attempts: 2, base: 2 * time.Second, ceiling: 2 * time.Second, status: unknownFailureStatus}, true
	}
	return retryRule{}, false
}

// backoff is the wait before retry number n (1 for the first retry) under rule,
// when the provider stated none: base doubled per retry, capped at ceiling, plus
// up to a quarter again at random so that every conversation that hit the same
// outage does not come back at the same instant.
func (rule retryRule) backoff(n int) time.Duration {
	wait := rule.base
	for i := 1; i < n && wait < rule.ceiling; i++ {
		wait *= 2
	}
	wait = min(wait, rule.ceiling)
	if wait <= 0 {
		return 0
	}
	return wait + rand.N(wait/4+1) //nolint:gosec // backoff jitter, not a secret
}

func rateLimitedStatus(a, max int, spent time.Duration) msg.Message {
	return msg.New("Rate limited, retrying ({attempt}/{max}){hasSpent, select, yes { — {spent} so far} other {}}", retryParams(a, max, spent)...)
}

func overloadedStatus(a, max int, spent time.Duration) msg.Message {
	return msg.New("Provider overloaded, retrying ({attempt}/{max}){hasSpent, select, yes { — {spent} so far} other {}}", retryParams(a, max, spent)...)
}

func serverErrorStatus(a, max int, spent time.Duration) msg.Message {
	return msg.New("Provider error, retrying ({attempt}/{max}){hasSpent, select, yes { — {spent} so far} other {}}", retryParams(a, max, spent)...)
}

func connectionDroppedStatus(a, max int, spent time.Duration) msg.Message {
	return msg.New("Connection dropped, retrying ({attempt}/{max}){hasSpent, select, yes { — {spent} so far} other {}}", retryParams(a, max, spent)...)
}

func unusableOutputStatus(a, max int, spent time.Duration) msg.Message {
	return msg.New("Unusable response, retrying ({attempt}/{max}){hasSpent, select, yes { — {spent} so far} other {}}", retryParams(a, max, spent)...)
}

func unknownFailureStatus(a, max int, spent time.Duration) msg.Message {
	return msg.New("Unexpected error, retrying ({attempt}/{max}){hasSpent, select, yes { — {spent} so far} other {}}", retryParams(a, max, spent)...)
}
