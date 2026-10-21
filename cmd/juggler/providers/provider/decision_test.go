//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type deciderProvider struct {
	baseOnlyProvider
	calls int
}

func (d *deciderProvider) Decide(_ context.Context, req DecisionRequest) (DecisionResult, error) {
	d.calls++
	answers := make(map[string]Answer, len(req.Questions))
	for _, q := range req.Questions {
		answers[q.ID] = Answer{Kind: q.Kind, Probability: 0.75}
	}
	return DecisionResult{Answers: answers, Usage: DecisionUsage{InputTokens: 7}}, nil
}

func yesNo(id string) Question {
	return Question{ID: id, Kind: QuestionYesNo, Instructions: "Is it safe?"}
}

// A zero is an answer: a certain "no", the bottom level of a scale, a model with
// no confidence at all. Each must reach the JSON as 0, never be dropped, and an
// answer must carry only the fields of its own kind.
func TestAnswerJSONKeepsZeroesAndOnlyItsOwnFields(t *testing.T) {
	cases := []struct {
		answer     Answer
		want, omit []string
	}{
		{Answer{Kind: QuestionYesNo}, []string{"kind", "probability"}, []string{"choice", "score", "confidence", "probabilities"}},
		{Answer{Kind: QuestionChoice, Choice: "a", Probabilities: map[string]float64{"a": 1}}, []string{"kind", "choice", "confidence", "probabilities"}, []string{"probability", "score"}},
		{Answer{Kind: QuestionScore, Probabilities: map[string]float64{"0": 1}}, []string{"kind", "score", "confidence", "probabilities"}, []string{"probability", "choice"}},
	}
	for _, c := range cases {
		raw, err := json.Marshal(c.answer)
		if err != nil {
			t.Fatalf("%s: %v", c.answer.Kind, err)
		}
		var fields map[string]any
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatalf("%s: %v", c.answer.Kind, err)
		}
		for _, k := range c.want {
			if _, ok := fields[k]; !ok {
				t.Errorf("%s answer %s is missing %q", c.answer.Kind, raw, k)
			}
		}
		for _, k := range c.omit {
			if _, ok := fields[k]; ok {
				t.Errorf("%s answer %s carries %q, which belongs to another kind", c.answer.Kind, raw, k)
			}
		}
		var back Answer
		if err := json.Unmarshal(raw, &back); err != nil || back.Kind != c.answer.Kind {
			t.Errorf("%s answer does not decode back: %+v, %v", c.answer.Kind, back, err)
		}
	}
}

func TestDecisionRequestValidate(t *testing.T) {
	choice := Question{ID: "c", Kind: QuestionChoice, Instructions: "which", Options: []QuestionOption{{Name: "a"}, {Name: "b"}}}
	score := Question{ID: "s", Kind: QuestionScore, Instructions: "how bad", Options: []QuestionOption{{Description: "fine"}, {Description: "awful"}}}

	valid := []DecisionRequest{
		{State: "x", Questions: []Question{yesNo("q")}},
		{State: "x", Questions: []Question{yesNo("q"), choice, score}},
	}
	for i, req := range valid {
		if err := req.Validate(); err != nil {
			t.Errorf("valid request %d rejected: %v", i, err)
		}
	}

	manyOptions := make([]QuestionOption, MaxChoiceOptions+1)
	for i := range manyOptions {
		manyOptions[i].Name = strings.Repeat("o", i+1)
	}
	manyLevels := make([]QuestionOption, MaxScoreLevels+1)
	for i := range manyLevels {
		manyLevels[i].Description = "level"
	}

	invalid := map[string]DecisionRequest{
		"no state":            {Questions: []Question{yesNo("q")}},
		"no questions":        {State: "x"},
		"empty id":            {State: "x", Questions: []Question{{Kind: QuestionYesNo, Instructions: "i"}}},
		"duplicate id":        {State: "x", Questions: []Question{yesNo("q"), yesNo("q")}},
		"no instructions":     {State: "x", Questions: []Question{{ID: "q", Kind: QuestionYesNo}}},
		"unknown kind":        {State: "x", Questions: []Question{{ID: "q", Kind: "box", Instructions: "i"}}},
		"yes-no with options": {State: "x", Questions: []Question{{ID: "q", Kind: QuestionYesNo, Instructions: "i", Options: []QuestionOption{{Name: "a"}}}}},
		"choice no options":   {State: "x", Questions: []Question{{ID: "q", Kind: QuestionChoice, Instructions: "i"}}},
		"choice unnamed":      {State: "x", Questions: []Question{{ID: "q", Kind: QuestionChoice, Instructions: "i", Options: []QuestionOption{{Description: "d"}}}}},
		"choice duplicate":    {State: "x", Questions: []Question{{ID: "q", Kind: QuestionChoice, Instructions: "i", Options: []QuestionOption{{Name: "a"}, {Name: "a"}}}}},
		"choice too many":     {State: "x", Questions: []Question{{ID: "q", Kind: QuestionChoice, Instructions: "i", Options: manyOptions}}},
		"score no levels":     {State: "x", Questions: []Question{{ID: "q", Kind: QuestionScore, Instructions: "i"}}},
		"score one level":     {State: "x", Questions: []Question{{ID: "q", Kind: QuestionScore, Instructions: "i", Options: []QuestionOption{{Description: "only"}}}}},
		"score blank level":   {State: "x", Questions: []Question{{ID: "q", Kind: QuestionScore, Instructions: "i", Options: []QuestionOption{{Description: "low"}, {}}}}},
		"score named level":   {State: "x", Questions: []Question{{ID: "q", Kind: QuestionScore, Instructions: "i", Options: []QuestionOption{{Name: "low"}}}}},
		"score too many":      {State: "x", Questions: []Question{{ID: "q", Kind: QuestionScore, Instructions: "i", Options: manyLevels}}},
	}
	for name, req := range invalid {
		if err := req.Validate(); err == nil {
			t.Errorf("%s: invalid request accepted", name)
		}
	}
}

func TestAsFindsDeciderThroughAdmissionWrapper(t *testing.T) {
	inner := &deciderProvider{}
	wrapped := &admissionProvider{Provider: inner, capabilities: ModelCapabilities{ContextWindowTokens: 64000}}

	d, ok := As[Decider](wrapped)
	if !ok {
		t.Fatal("As did not find Decider under the wrapper")
	}
	if d == Decider(inner) {
		t.Fatal("As returned the unchecked provider, so admission would be skipped")
	}
	res, err := d.Decide(context.Background(), DecisionRequest{State: "x", Questions: []Question{yesNo("q")}})
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Answers["q"].Probability; got != 0.75 {
		t.Fatalf("probability = %v, want 0.75", got)
	}
	if inner.calls != 1 {
		t.Fatalf("provider decided %d times, want 1", inner.calls)
	}
}

func TestAsReportsMissingDecider(t *testing.T) {
	if _, ok := As[Decider](&admissionProvider{Provider: baseOnlyProvider{}}); ok {
		t.Fatal("the wrapper claimed a Decider the provider underneath does not have")
	}
	if _, ok := As[Decider](&admissionProvider{Provider: chatProvider{}}); ok {
		t.Fatal("a chat-only provider was found to be a Decider")
	}
}

func TestDecideRejectsProviderWithoutDecisions(t *testing.T) {
	wrapped := &admissionProvider{Provider: chatProvider{}}
	_, err := Decide(context.Background(), wrapped, DecisionRequest{State: "x", Questions: []Question{yesNo("q")}})
	if err == nil || !strings.Contains(err.Error(), "does not support decisions") {
		t.Fatalf("err = %v, want a does-not-support-decisions error", err)
	}
}

func TestAdmissionRefusesDecisionOverContextWindow(t *testing.T) {
	inner := &deciderProvider{}
	wrapped := &admissionProvider{Provider: inner, capabilities: ModelCapabilities{ContextWindowTokens: 100}}

	_, err := Decide(context.Background(), wrapped, DecisionRequest{State: strings.Repeat("word ", 400), Questions: []Question{yesNo("q")}})
	var tooLarge *DecisionTooLargeError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("err = %v, want DecisionTooLargeError", err)
	}
	if tooLarge.ContextWindowTokens != 100 || tooLarge.EstimatedInputTokens <= 100 {
		t.Fatalf("error carries window %d and estimate %d", tooLarge.ContextWindowTokens, tooLarge.EstimatedInputTokens)
	}
	if inner.calls != 0 {
		t.Fatal("an oversized request reached the provider")
	}
}

// A model can bound each question as well as the whole request (Jev: 64k per
// request, 32k for the state plus any one question). A request that fits the
// window but not the per-question bound must be refused here, not by the API.
func TestAdmissionRefusesDecisionOverQuestionLimit(t *testing.T) {
	inner := &deciderProvider{}
	wrapped := &admissionProvider{Provider: inner, capabilities: ModelCapabilities{ContextWindowTokens: 64000, QuestionContextTokens: 100}}

	_, err := Decide(context.Background(), wrapped, DecisionRequest{State: strings.Repeat("word ", 400), Questions: []Question{yesNo("ok"), yesNo("q")}})
	var tooLarge *DecisionTooLargeError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("err = %v, want DecisionTooLargeError", err)
	}
	if tooLarge.ContextWindowTokens != 100 || tooLarge.EstimatedInputTokens <= 100 || tooLarge.Question == "" {
		t.Fatalf("error carries limit %d, estimate %d, question %q", tooLarge.ContextWindowTokens, tooLarge.EstimatedInputTokens, tooLarge.Question)
	}
	if !strings.Contains(tooLarge.Error(), "per-question") {
		t.Fatalf("error %q does not say which limit was hit", tooLarge.Error())
	}
	if inner.calls != 0 {
		t.Fatal("a request over the per-question limit reached the provider")
	}
}

// The per-question bound is per question: several questions whose sum is over
// it, each of which fits alongside the state, are fine.
func TestAdmissionQuestionLimitIsNotARequestLimit(t *testing.T) {
	q := yesNo("a")
	one := EstimateDecisionRequestTokens(DecisionRequest{State: "short", Questions: []Question{q}}, 0)
	req := DecisionRequest{State: "short", Questions: []Question{yesNo("a"), yesNo("b"), yesNo("c")}}
	wrapped := &admissionProvider{Provider: &deciderProvider{}, capabilities: ModelCapabilities{ContextWindowTokens: 64000, QuestionContextTokens: one}}
	if _, err := Decide(context.Background(), wrapped, req); err != nil {
		t.Fatalf("questions that each fit were refused: %v", err)
	}
}

func TestAdmissionCountsProviderOverheadForDecisions(t *testing.T) {
	req := DecisionRequest{State: "short", Questions: []Question{yesNo("q")}}
	base := EstimateDecisionRequestTokens(req, 0)

	fits := &admissionProvider{Provider: &deciderProvider{}, capabilities: ModelCapabilities{ContextWindowTokens: base}}
	if _, err := Decide(context.Background(), fits, req); err != nil {
		t.Fatalf("request that exactly fits was refused: %v", err)
	}
	overhead := &admissionProvider{Provider: &deciderProvider{}, capabilities: ModelCapabilities{ContextWindowTokens: base, ProviderOverheadTokens: 1}}
	var tooLarge *DecisionTooLargeError
	if _, err := Decide(context.Background(), overhead, req); !errors.As(err, &tooLarge) {
		t.Fatalf("err = %v, want DecisionTooLargeError once overhead tips it over", err)
	}
}

func TestAdmissionUnknownDecisionWindow(t *testing.T) {
	req := DecisionRequest{State: "x", Questions: []Question{yesNo("q")}}

	closed := &admissionProvider{Provider: &deciderProvider{}}
	var unknown *UnknownContextLimitError
	if _, err := Decide(context.Background(), closed, req); !errors.As(err, &unknown) {
		t.Fatalf("err = %v, want UnknownContextLimitError", err)
	}

	inner := &deciderProvider{}
	open := &admissionProvider{Provider: inner, contract: BudgetContract{AllowUnknownLimits: true}}
	if _, err := Decide(context.Background(), open, req); err != nil {
		t.Fatalf("AllowUnknownLimits provider refused: %v", err)
	}
	if inner.calls != 1 {
		t.Fatalf("provider decided %d times, want 1", inner.calls)
	}
}

func TestAdmissionRejectsMalformedDecisionBeforeProvider(t *testing.T) {
	inner := &deciderProvider{}
	wrapped := &admissionProvider{Provider: inner, capabilities: ModelCapabilities{ContextWindowTokens: 64000}}
	if _, err := Decide(context.Background(), wrapped, DecisionRequest{State: "x"}); err == nil {
		t.Fatal("a request with no questions was accepted")
	}
	if inner.calls != 0 {
		t.Fatal("a malformed request reached the provider")
	}
}

func TestInitializeProviderExposesCheckedDecider(t *testing.T) {
	const name = "decision-test-decider"
	RegisterProvider(ProviderInfo{Name: name, Decisions: true, DecisionOnly: true}, func(Config) (Provider, error) {
		return &deciderProvider{}, nil
	})
	t.Cleanup(func() { UnregisterProvider(name) })

	initialized, err := InitializeProvider(name, Config{Model: "m", ModelCapabilities: ModelCapabilities{ContextWindowTokens: 50}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := As[ConversationProvider](initialized); ok {
		t.Fatal("a decision-only provider was found to chat")
	}
	var tooLarge *DecisionTooLargeError
	_, err = Decide(context.Background(), initialized, DecisionRequest{State: strings.Repeat("word ", 400), Questions: []Question{yesNo("q")}})
	if !errors.As(err, &tooLarge) {
		t.Fatalf("err = %v, want the initialized provider's Decider to be admission-checked", err)
	}

	info, _ := GetProviderInfo(name)
	if !info.Decisions || info.Chats() {
		t.Fatalf("info = %+v, want a decisions-only provider", info)
	}
}
