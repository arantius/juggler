//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/userpaths/userpathstest"
)

const (
	decisionTestProvider = "decision-test"
	chatTestProvider     = "decision-test-chat"
)

// fakeDecider is a decision-only provider whose behaviour the test supplies.
type fakeDecider struct {
	decide func(context.Context, provider.DecisionRequest) (provider.DecisionResult, error)
}

func (fakeDecider) Name() string { return decisionTestProvider }
func (fakeDecider) ListModelsWithInfo(context.Context) ([]provider.ModelInfo, error) {
	return nil, nil
}
func (f fakeDecider) Decide(ctx context.Context, req provider.DecisionRequest) (provider.DecisionResult, error) {
	return f.decide(ctx, req)
}

// chatOnly is a provider that chats and offers no decisions.
type chatOnly struct{}

func (chatOnly) Name() string { return chatTestProvider }
func (chatOnly) ListModelsWithInfo(context.Context) ([]provider.ModelInfo, error) {
	return nil, nil
}
func (chatOnly) OpenConversation(context.Context, string) (provider.Conversation, error) {
	return nil, errors.New("not used")
}

// yesWith answers every yes/no question with probability p.
func yesWith(p float64) func(context.Context, provider.DecisionRequest) (provider.DecisionResult, error) {
	return func(_ context.Context, req provider.DecisionRequest) (provider.DecisionResult, error) {
		answers := make(map[string]provider.Answer, len(req.Questions))
		for _, q := range req.Questions {
			answers[q.ID] = provider.Answer{Kind: q.Kind, Probability: p}
		}
		return provider.DecisionResult{Answers: answers, Usage: provider.DecisionUsage{InputTokens: 11, OutputTokens: 1}}, nil
	}
}

// registerDecisionTestProviders registers a decision-only provider and a
// chat-only one, and gives both an API key so credential lookup succeeds.
func registerDecisionTestProviders(t *testing.T, decide func(context.Context, provider.DecisionRequest) (provider.DecisionResult, error)) {
	t.Helper()
	provider.RegisterProvider(provider.ProviderInfo{
		Name:                decisionTestProvider,
		ConfigKeyName:       "decision_test_api_key",
		ModelContextWindows: map[string]int{"jev-test": 1000},
		ResolveModelCapabilities: func(model string) (provider.ModelCapabilities, bool) {
			return provider.ModelCapabilities{ContextWindowTokens: 1000}, model == "jev-test"
		},
		Decisions:    true,
		DecisionOnly: true,
	}, func(provider.Config) (provider.Provider, error) { return fakeDecider{decide: decide}, nil })
	provider.RegisterProvider(provider.ProviderInfo{
		Name:          chatTestProvider,
		ConfigKeyName: "decision_test_chat_api_key",
	}, func(provider.Config) (provider.Provider, error) { return chatOnly{}, nil })
	t.Cleanup(func() {
		provider.UnregisterProvider(decisionTestProvider)
		provider.UnregisterProvider(chatTestProvider)
	})

	creds, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{decisionTestProvider, chatTestProvider} {
		if err := creds.SetAPIKey(name, "key"); err != nil {
			t.Fatal(err)
		}
	}
}

func decisionStatus(available bool, models ...ModelWithContext) ProviderStatus {
	return ProviderStatus{
		Name: decisionTestProvider, Available: available, Decisions: true, DecisionOnly: true,
		ModelsWithContext: models,
	}
}

// newDecisionServer builds a Server with the providers-ready gate open, a live
// provider list installed, an isolated decision-model store and a pool.
func newDecisionServer(t *testing.T, decide func(context.Context, provider.DecisionRequest) (provider.DecisionResult, error), providers ...ProviderStatus) *Server {
	t.Helper()
	userpathstest.Isolate(t)
	registerDecisionTestProviders(t, decide)
	store, err := core.NewDecisionModelStore()
	if err != nil {
		t.Fatalf("NewDecisionModelStore: %v", err)
	}
	s := &Server{
		providerRefresh:  providerRefresh{providersReady: make(chan struct{})},
		serverStores:     serverStores{decisionModelStore: store},
		quickCompleteSem: make(chan struct{}, quickCompleteConcurrency),
	}
	s.providersList.Store(&providers)
	s.markProvidersReady()
	return s
}

func pinDecision(t *testing.T, s *Server, provider, model string) {
	t.Helper()
	if err := s.decisionModelStore.Save(core.ModelRef{Provider: provider, Model: model}); err != nil {
		t.Fatalf("Save: %v", err)
	}
}

func TestResolveDecisionModel(t *testing.T) {
	live := decisionStatus(true, ModelWithContext{ID: "jev-test"}, ModelWithContext{ID: "jev-hidden", Hidden: true})
	ctx := context.Background()

	t.Run("nothing chosen", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1), live)
		if ref, ok := s.resolveDecisionModel(ctx); ok {
			t.Fatalf("resolved %+v with nothing chosen: a decision model is never derived", ref)
		}
	})
	t.Run("no store", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1), live)
		s.decisionModelStore = nil
		if _, ok := s.resolveDecisionModel(ctx); ok {
			t.Fatal("resolved without a store")
		}
	})
	t.Run("chosen and serving", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1), live)
		pinDecision(t, s, decisionTestProvider, "jev-test")
		ref, ok := s.resolveDecisionModel(ctx)
		if !ok || ref != (core.ModelRef{Provider: decisionTestProvider, Model: "jev-test"}) {
			t.Fatalf("got %+v, %v", ref, ok)
		}
	})
	t.Run("provider unavailable", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1), decisionStatus(false, ModelWithContext{ID: "jev-test"}))
		pinDecision(t, s, decisionTestProvider, "jev-test")
		if _, ok := s.resolveDecisionModel(ctx); ok {
			t.Fatal("resolved a model of an unavailable provider")
		}
	})
	t.Run("model no longer listed", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1), live)
		pinDecision(t, s, decisionTestProvider, "jev-retired")
		if _, ok := s.resolveDecisionModel(ctx); ok {
			t.Fatal("resolved a model the provider no longer lists")
		}
	})
	t.Run("model hidden by the user", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1), live)
		pinDecision(t, s, decisionTestProvider, "jev-hidden")
		if _, ok := s.resolveDecisionModel(ctx); ok {
			t.Fatal("resolved a model the user turned off")
		}
	})
	t.Run("provider offers no decisions", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1), ProviderStatus{Name: chatTestProvider, Available: true, ModelsWithContext: []ModelWithContext{{ID: "m"}}})
		pinDecision(t, s, chatTestProvider, "m")
		if _, ok := s.resolveDecisionModel(ctx); ok {
			t.Fatal("resolved a chat provider as a decision model")
		}
	})
}

func getDecisionModel(t *testing.T, s *Server) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleDecisionModel(rec, httptest.NewRequest(http.MethodGet, "/api/decision-model", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func putDecisionModel(s *Server, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handlers.NewDecisionModelAPI(s.decisionModelStore).HandleSet(rec, httptest.NewRequest(http.MethodPut, "/api/decision-model", strings.NewReader(body)))
	return rec
}

func TestDecisionModelHandlerReportsTheChoice(t *testing.T) {
	s := newDecisionServer(t, yesWith(1), decisionStatus(true, ModelWithContext{ID: "jev-test"}))

	if body := getDecisionModel(t, s); body["explicit"] != false || body["available"] != false || body["provider"] != nil {
		t.Fatalf("with nothing chosen: %v", body)
	}

	if rec := putDecisionModel(s, `{"provider":"`+decisionTestProvider+`","model":"jev-test"}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d: %s", rec.Code, rec.Body.String())
	}
	body := getDecisionModel(t, s)
	if body["explicit"] != true || body["available"] != true || body["provider"] != decisionTestProvider || body["model"] != "jev-test" {
		t.Fatalf("after choosing: %v", body)
	}

	// A choice that can no longer serve is still reported, so the settings row
	// can say it is not being used instead of dropping it silently.
	s.providersList.Store(&[]ProviderStatus{decisionStatus(false, ModelWithContext{ID: "jev-test"})})
	body = getDecisionModel(t, s)
	if body["explicit"] != true || body["available"] != false || body["model"] != "jev-test" {
		t.Fatalf("after the provider went away: %v", body)
	}

	if rec := putDecisionModel(s, `{}`); rec.Code != http.StatusOK {
		t.Fatalf("clearing = %d: %s", rec.Code, rec.Body.String())
	}
	if body := getDecisionModel(t, s); body["explicit"] != false {
		t.Fatalf("after clearing: %v", body)
	}
}

func TestSetDecisionModelRefusesWhatCannotDecide(t *testing.T) {
	s := newDecisionServer(t, yesWith(1))

	for name, body := range map[string]string{
		"chat provider":    `{"provider":"` + chatTestProvider + `","model":"m"}`,
		"unknown provider": `{"provider":"nope","model":"m"}`,
		"no model":         `{"provider":"` + decisionTestProvider + `"}`,
		"no provider":      `{"model":"jev-test"}`,
	} {
		if rec := putDecisionModel(s, body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: PUT = %d, want 400", name, rec.Code)
		}
	}
	if stored, _ := s.decisionModelStore.Load(); stored != (core.ModelRef{}) {
		t.Fatalf("a refused choice was stored: %+v", stored)
	}

	s.decisionModelStore = nil
	if rec := putDecisionModel(s, `{}`); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("without a store: PUT = %d, want 503", rec.Code)
	}
}

func TestDefaultModelNeverPicksADecisionOnlyProvider(t *testing.T) {
	chat := ProviderStatus{Name: "zzz-chat", Available: true, ModelsWithContext: []ModelWithContext{{ID: "chat-model"}}}

	// Alphabetically the decision provider sorts first among unranked providers,
	// so only the exclusion keeps it from being picked.
	ref, ok := preferredAvailableModel([]ProviderStatus{decisionStatus(true, ModelWithContext{ID: "jev-test"}), chat}, nil)
	if !ok || ref.Provider != "zzz-chat" {
		t.Fatalf("got %+v, %v, want the chat provider", ref, ok)
	}
	if ref, ok := preferredAvailableModel([]ProviderStatus{decisionStatus(true, ModelWithContext{ID: "jev-test"})}, nil); ok {
		t.Fatalf("seeded a conversation on %+v with only a decision model available", ref)
	}
}

func TestOnboardingDoesNotCountADecisionModelAsASetUpProvider(t *testing.T) {
	s := newDecisionServer(t, yesWith(1), decisionStatus(true, ModelWithContext{ID: "jev-test"}))
	if s.anyProviderAvailable() {
		t.Fatal("a decision model alone counted as a provider that can start a conversation")
	}
	providers := []ProviderStatus{decisionStatus(true, ModelWithContext{ID: "jev-test"}), {Name: "c", Available: true, ModelsWithContext: []ModelWithContext{{ID: "m"}}}}
	s.providersList.Store(&providers)
	if !s.anyProviderAvailable() {
		t.Fatal("a chat provider no longer counts")
	}
}

func postDecide(s *Server, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.handleLLMDecide(rec, httptest.NewRequest(http.MethodPost, "/api/llm/decide", strings.NewReader(body)))
	return rec
}

const safeQuestion = `{"state":"ls -la","questions":[{"id":"safe","kind":"yes-no","instructions":"The command is safe"}]`

func TestHandleLLMDecideRunsTheChosenModel(t *testing.T) {
	s := newDecisionServer(t, yesWith(0.93), decisionStatus(true, ModelWithContext{ID: "jev-test"}))
	pinDecision(t, s, decisionTestProvider, "jev-test")

	rec := postDecide(s, safeQuestion+`}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Answers map[string]struct {
			Kind        string  `json:"kind"`
			Probability float64 `json:"probability"`
		} `json:"answers"`
		Usage struct {
			InputTokens  int `json:"inputTokens"`
			OutputTokens int `json:"outputTokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if a := res.Answers["safe"]; a.Kind != "yes-no" || a.Probability != 0.93 {
		t.Fatalf("answer = %+v", a)
	}
	if res.Usage.InputTokens != 11 || res.Usage.OutputTokens != 1 {
		t.Fatalf("usage = %+v", res.Usage)
	}
}

func TestHandleLLMDecideAcceptsAnExplicitModel(t *testing.T) {
	s := newDecisionServer(t, yesWith(0.5), decisionStatus(true, ModelWithContext{ID: "jev-test"}))
	// Nothing chosen in Settings: naming the model in the request still works.
	rec := postDecide(s, safeQuestion+`,"model":{"provider":"`+decisionTestProvider+`","model":"jev-test"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleLLMDecideRefusals(t *testing.T) {
	s := newDecisionServer(t, yesWith(1), decisionStatus(true, ModelWithContext{ID: "jev-test"}),
		ProviderStatus{Name: chatTestProvider, Available: true, ModelsWithContext: []ModelWithContext{{ID: "m"}}})

	// Nothing chosen is the one refusal that is not the request's fault.
	if rec := postDecide(s, safeQuestion+`}`); rec.Code != http.StatusConflict {
		t.Errorf("no decision model chosen: status = %d, want 409 (%s)", rec.Code, rec.Body.String())
	}
	if rec := postDecide(s, safeQuestion+`,"model":"decision"}`); rec.Code != http.StatusConflict {
		t.Errorf("the decision alias with none chosen: status = %d, want 409 (%s)", rec.Code, rec.Body.String())
	}

	cases := map[string]string{
		"unknown alias":    safeQuestion + `,"model":"cheap"}`,
		"chat provider":    safeQuestion + `,"model":{"provider":"` + chatTestProvider + `","model":"m"}}`,
		"model not listed": safeQuestion + `,"model":{"provider":"` + decisionTestProvider + `","model":"gone"}}`,
		"no questions":     `{"state":"x","questions":[]}`,
		"no state":         `{"questions":[{"id":"q","kind":"yes-no","instructions":"i"}]}`,
		"bad kind":         `{"state":"x","questions":[{"id":"q","kind":"box","instructions":"i"}]}`,
		"malformed model":  safeQuestion + `,"model":{"provider":"x"}}`,
	}
	for name, body := range cases {
		if rec := postDecide(s, body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 (%s)", name, rec.Code, rec.Body.String())
		}
	}
}

func TestQuickDecideStatuses(t *testing.T) {
	ref := core.ModelRef{Provider: decisionTestProvider, Model: "jev-test"}
	req := provider.DecisionRequest{State: "x", Questions: []provider.Question{{ID: "q", Kind: provider.QuestionYesNo, Instructions: "i"}}}

	t.Run("pool saturated", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1))
		for i := 0; i < quickCompleteConcurrency; i++ {
			s.quickCompleteSem <- struct{}{}
		}
		_, err := s.QuickDecide(context.Background(), QuickDecideRequest{Model: ref, Request: req})
		if !errors.Is(err, ErrQuickCompleteBusy) {
			t.Fatalf("err = %v, want ErrQuickCompleteBusy", err)
		}
		if status, _ := completeErrorStatus(err); status != http.StatusTooManyRequests {
			t.Fatalf("status = %d, want 429", status)
		}
	})

	t.Run("bound elapsed", func(t *testing.T) {
		s := newDecisionServer(t, func(ctx context.Context, _ provider.DecisionRequest) (provider.DecisionResult, error) {
			<-ctx.Done()
			return provider.DecisionResult{}, ctx.Err()
		})
		_, err := s.QuickDecide(context.Background(), QuickDecideRequest{Model: ref, Request: req, Timeout: 30 * time.Millisecond})
		if !errors.Is(err, ErrQuickCompleteTimeout) {
			t.Fatalf("err = %v, want ErrQuickCompleteTimeout", err)
		}
	})

	t.Run("slot released", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1))
		for i := 0; i < 2*quickCompleteConcurrency; i++ {
			if _, err := s.QuickDecide(context.Background(), QuickDecideRequest{Model: ref, Request: req}); err != nil {
				t.Fatalf("decision %d: %v", i, err)
			}
		}
	})

	t.Run("request over the context window", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1))
		big := req
		big.State = strings.Repeat("word ", 5000)
		var tooLarge *provider.DecisionTooLargeError
		_, err := s.QuickDecide(context.Background(), QuickDecideRequest{Model: ref, Request: big})
		if !errors.As(err, &tooLarge) {
			t.Fatalf("err = %v, want DecisionTooLargeError from admission", err)
		}
	})

	t.Run("provider cannot decide", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1))
		_, err := s.QuickDecide(context.Background(), QuickDecideRequest{Model: core.ModelRef{Provider: chatTestProvider, Model: "m"}, Request: req})
		if err == nil || !strings.Contains(err.Error(), "does not make decisions") {
			t.Fatalf("err = %v, want a does-not-make-decisions error", err)
		}
	})

	t.Run("blank request", func(t *testing.T) {
		s := newDecisionServer(t, yesWith(1))
		if _, err := s.QuickDecide(context.Background(), QuickDecideRequest{Request: req}); err == nil {
			t.Fatal("accepted a request with no model")
		}
		if _, err := s.QuickDecide(context.Background(), QuickDecideRequest{Model: ref}); err == nil {
			t.Fatal("accepted a request with no questions")
		}
	})

	t.Run("concurrent decisions", func(t *testing.T) {
		var wg sync.WaitGroup
		s := newDecisionServer(t, yesWith(1))
		for i := 0; i < quickCompleteConcurrency; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := s.QuickDecide(context.Background(), QuickDecideRequest{Model: ref, Request: req}); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
	})
}
