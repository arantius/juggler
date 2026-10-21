//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"encoding/json"
	"fmt"
)

// QuestionKind is the form of answer a Question asks for. A decision model
// answers with a probability or a pick from options the caller defined, never
// with free text, so the kind is the whole contract between a question and the
// shape of its answer.
type QuestionKind string

const (
	// QuestionYesNo asks whether a statement holds and is answered with the
	// probability that it does.
	QuestionYesNo QuestionKind = "yes-no"
	// QuestionChoice asks for exactly one of a fixed set of options and is
	// answered with the pick and a probability for every option.
	QuestionChoice QuestionKind = "choice"
	// QuestionScore asks for a position on an ordered scale and is answered with
	// the probability-weighted position and a probability for every level.
	QuestionScore QuestionKind = "score"
)

// MaxChoiceOptions, MinScoreLevels and MaxScoreLevels bound the options of a
// question. They are the limits the first decision-model API publishes; a
// provider that allows more is simply never asked for more.
const (
	MaxChoiceOptions = 255
	MinScoreLevels   = 2
	MaxScoreLevels   = 10
)

// QuestionOption is one option of a choice question, or one level of a score
// question.
type QuestionOption struct {
	// Name identifies a choice option in the answer. A score level has no name:
	// its position in Question.Options is its score, counting from zero.
	Name string `json:"name,omitempty"`
	// Description says what the option means. A choice option may leave it empty
	// and be understood from its name alone.
	Description string `json:"description,omitempty"`
}

// Question is one thing a decision model is asked about the request's state.
type Question struct {
	// ID names the question in the answers. The caller chooses it; it is never
	// sent to the model as a hint.
	ID string `json:"id"`
	// Kind is the form of answer wanted.
	Kind QuestionKind `json:"kind"`
	// Instructions is the question itself: the statement a yes-no question
	// evaluates, or what a choice or score question is asked to decide.
	Instructions string `json:"instructions"`
	// Options are the choices of a choice question, or the ordered levels of a
	// score question. A yes-no question has none.
	Options []QuestionOption `json:"options,omitempty"`
}

// DecisionRequest is a bounded decision: some text to judge and the questions to
// judge it by. All questions are answered about the same State in one call.
type DecisionRequest struct {
	// State is the content every question refers to.
	State string `json:"state"`
	// Questions are asked in parallel. At least one is required.
	Questions []Question `json:"questions"`
}

// Validate reports why the request cannot be asked of any decision model, or nil
// when it is well-formed. Providers and the admission wrapper share it so a
// malformed request fails the same way wherever it is caught, before a byte
// leaves the machine.
func (r DecisionRequest) Validate() error {
	if r.State == "" {
		return fmt.Errorf("decision request has no state")
	}
	if len(r.Questions) == 0 {
		return fmt.Errorf("decision request has no questions")
	}
	seen := make(map[string]struct{}, len(r.Questions))
	for _, q := range r.Questions {
		if q.ID == "" {
			return fmt.Errorf("decision question has no id")
		}
		if _, dup := seen[q.ID]; dup {
			return fmt.Errorf("decision question id %q is used twice", q.ID)
		}
		seen[q.ID] = struct{}{}
		if q.Instructions == "" {
			return fmt.Errorf("decision question %q has no instructions", q.ID)
		}
		if err := q.validateOptions(); err != nil {
			return err
		}
	}
	return nil
}

func (q Question) validateOptions() error {
	switch q.Kind {
	case QuestionYesNo:
		if len(q.Options) != 0 {
			return fmt.Errorf("yes-no question %q takes no options", q.ID)
		}
	case QuestionChoice:
		if len(q.Options) == 0 || len(q.Options) > MaxChoiceOptions {
			return fmt.Errorf("choice question %q needs 1 to %d options, has %d", q.ID, MaxChoiceOptions, len(q.Options))
		}
		names := make(map[string]struct{}, len(q.Options))
		for _, o := range q.Options {
			if o.Name == "" {
				return fmt.Errorf("choice question %q has an option with no name", q.ID)
			}
			if _, dup := names[o.Name]; dup {
				return fmt.Errorf("choice question %q has option %q twice", q.ID, o.Name)
			}
			names[o.Name] = struct{}{}
		}
	case QuestionScore:
		if len(q.Options) < MinScoreLevels || len(q.Options) > MaxScoreLevels {
			return fmt.Errorf("score question %q needs %d to %d levels, has %d", q.ID, MinScoreLevels, MaxScoreLevels, len(q.Options))
		}
		for _, o := range q.Options {
			if o.Name != "" {
				return fmt.Errorf("score question %q has a named level; a level is identified by its position", q.ID)
			}
			if o.Description == "" {
				return fmt.Errorf("score question %q has a level with no description", q.ID)
			}
		}
	default:
		return fmt.Errorf("decision question %q has unknown kind %q", q.ID, q.Kind)
	}
	return nil
}

// Answer is a decision model's reply to one Question. Which fields are set
// follows Kind, and the rest are left at their zero value. Its JSON carries
// exactly the fields of its kind (see MarshalJSON).
type Answer struct {
	Kind QuestionKind `json:"kind"`
	// Probability is the chance the statement holds, from 0 to 1. Set only for
	// QuestionYesNo.
	Probability float64 `json:"probability"`
	// Choice is the option picked. Set only for QuestionChoice.
	Choice string `json:"choice"`
	// Score is the probability-weighted position on the scale. Set only for
	// QuestionScore.
	Score float64 `json:"score"`
	// Confidence is how settled the model is on a choice or score, from 0 to 1.
	// A yes-no answer carries none: its probability already is its confidence.
	Confidence float64 `json:"confidence"`
	// Probabilities gives the probability of each option, keyed by option name
	// for a choice and by level position ("0", "1", ...) for a score.
	Probabilities map[string]float64 `json:"probabilities"`
}

// MarshalJSON writes the fields of the answer's kind and no others. Kind decides
// presence rather than omitempty, because a zero is a real answer here: a
// certain "no", the bottom level of a scale, no confidence at all. Dropped, each
// would read to a caller as a field the model never sent.
func (a Answer) MarshalJSON() ([]byte, error) {
	switch a.Kind {
	case QuestionYesNo:
		return json.Marshal(struct {
			Kind        QuestionKind `json:"kind"`
			Probability float64      `json:"probability"`
		}{a.Kind, a.Probability})
	case QuestionChoice:
		return json.Marshal(struct {
			Kind          QuestionKind       `json:"kind"`
			Choice        string             `json:"choice"`
			Confidence    float64            `json:"confidence"`
			Probabilities map[string]float64 `json:"probabilities"`
		}{a.Kind, a.Choice, a.Confidence, a.Probabilities})
	case QuestionScore:
		return json.Marshal(struct {
			Kind          QuestionKind       `json:"kind"`
			Score         float64            `json:"score"`
			Confidence    float64            `json:"confidence"`
			Probabilities map[string]float64 `json:"probabilities"`
		}{a.Kind, a.Score, a.Confidence, a.Probabilities})
	}
	return json.Marshal(struct {
		Kind QuestionKind `json:"kind"`
	}{a.Kind})
}

// DecisionUsage is the billable size of a decision, in the same terms as the
// token counts of a chat turn.
type DecisionUsage struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
}

// DecisionResult carries one Answer per question of the request, keyed by
// Question.ID.
type DecisionResult struct {
	Answers map[string]Answer `json:"answers"`
	Usage   DecisionUsage     `json:"usage"`
}

// Decider is implemented by providers whose models answer questions about a
// piece of text with probabilities or picks, instead of generating text. Such a
// model is cheap and fast enough to sit in a decision path, such as judging
// whether a tool call needs a person, where a chat model would be slow and its
// free-text verdict would have to be parsed.
//
// A Decider is a capability separate from ConversationProvider, so a provider
// can offer chat, decisions, or both. Look it up with As[Decider], or use
// Decide, which also reports a provider that has none.
type Decider interface {
	// Decide answers every question of req about req.State. It returns an answer
	// for each question or an error; a partial result is never returned.
	Decide(ctx context.Context, req DecisionRequest) (DecisionResult, error)
}

// Decide asks p's decision model req, or fails if p cannot make decisions. When
// p is wrapped by admission control the request is checked against the model's
// context window first, because As hands out the checked Decider, never the
// provider underneath.
func Decide(ctx context.Context, p Provider, req DecisionRequest) (DecisionResult, error) {
	d, ok := As[Decider](p)
	if !ok {
		return DecisionResult{}, fmt.Errorf("provider %q does not support decisions", p.Name())
	}
	return d.Decide(ctx, req)
}

// DecisionTooLargeError reports a decision request that cannot fit the model's
// context window. A conversation can compact its history to make room; a
// decision has nothing to drop, so the caller has to ask something smaller.
//
// Question is empty when the whole request is over ContextWindowTokens. When it
// names a question, that question with the state is over the model's
// per-question limit, and ContextWindowTokens holds that limit.
type DecisionTooLargeError struct {
	EstimatedInputTokens int64
	ContextWindowTokens  int64
	Question             string
}

func (e *DecisionTooLargeError) Error() string {
	if e.Question != "" {
		return fmt.Sprintf("decision question %q with the state is estimated at %d input tokens, over the model's %d-token per-question limit", e.Question, e.EstimatedInputTokens, e.ContextWindowTokens)
	}
	return fmt.Sprintf("the decision request is estimated at %d input tokens, over the model's %d-token context window", e.EstimatedInputTokens, e.ContextWindowTokens)
}

// Retryable allows generic error classifiers to identify this as terminal.
func (e *DecisionTooLargeError) Retryable() bool { return false }

// EstimateDecisionRequestTokens conservatively estimates the input of req with
// the same heuristic chat admission uses. Unmarshalable question data saturates
// it rather than being counted as free.
func EstimateDecisionRequestTokens(req DecisionRequest, providerOverhead int64) int64 {
	total := approximateTokenCount(req.State)
	for _, q := range req.Questions {
		total = SaturatingAdd(total, marshaledTokenCount(q))
	}
	if providerOverhead > 0 {
		total = SaturatingAdd(total, providerOverhead)
	}
	return total
}

// admissionDecider is the Decider admission control hands out: every request is
// checked against the model's context window, and each question against its
// per-question limit if it has one, before it reaches the provider.
type admissionDecider struct {
	inner        Decider
	capabilities ModelCapabilities
	contract     BudgetContract
}

func (d admissionDecider) Decide(ctx context.Context, req DecisionRequest) (DecisionResult, error) {
	if err := req.Validate(); err != nil {
		return DecisionResult{}, err
	}
	if limit := d.capabilities.QuestionContextTokens; limit > 0 {
		for _, q := range req.Questions {
			one := DecisionRequest{State: req.State, Questions: []Question{q}}
			if estimated := EstimateDecisionRequestTokens(one, d.capabilities.ProviderOverheadTokens); estimated > limit {
				return DecisionResult{}, &DecisionTooLargeError{EstimatedInputTokens: estimated, ContextWindowTokens: limit, Question: q.ID}
			}
		}
	}
	window := d.capabilities.ContextWindowTokens
	if window <= 0 {
		if d.contract.AllowUnknownLimits {
			return d.inner.Decide(ctx, req)
		}
		return DecisionResult{}, &UnknownContextLimitError{ContextWindowTokens: window}
	}
	// A decision model's output is a handful of numbers, so unlike a chat turn
	// there is no output reserve to hold back: the whole window is the ceiling.
	if estimated := EstimateDecisionRequestTokens(req, d.capabilities.ProviderOverheadTokens); estimated > window {
		return DecisionResult{}, &DecisionTooLargeError{EstimatedInputTokens: estimated, ContextWindowTokens: window}
	}
	return d.inner.Decide(ctx, req)
}
