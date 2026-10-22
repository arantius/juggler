//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package jev

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New(provider.Config{APIKey: "key-123", Model: "jev-latest", BaseURL: srv.URL + "/v1/"})
}

func allKinds() provider.DecisionRequest {
	return provider.DecisionRequest{
		State: "rm -rf build",
		Questions: []provider.Question{
			{ID: "safe", Kind: provider.QuestionYesNo, Instructions: "The command is safe to run"},
			{ID: "kind", Kind: provider.QuestionChoice, Instructions: "What does it do", Options: []provider.QuestionOption{
				{Name: "read"}, {Name: "delete", Description: "removes files"},
			}},
			{ID: "risk", Kind: provider.QuestionScore, Instructions: "How risky", Options: []provider.QuestionOption{
				{Description: "harmless"}, {Description: "dangerous"},
			}},
		},
	}
}

func TestDecideSendsTheDocumentedRequest(t *testing.T) {
	var got struct {
		method, path, auth, contentType string
		body                            map[string]any
	}
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		got.method, got.path = r.Method, r.URL.Path
		got.auth, got.contentType = r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got.body)
		_, _ = io.WriteString(w, `{"model":"jev-1.13.0","answers":{
			"safe":{"type":"noul","noul":0.97},
			"kind":{"type":"choice","choice":"delete","confidence":0.8,"probabilities":{"read":0.2,"delete":0.8}},
			"risk":{"type":"score","score":0.6,"confidence":0.4,"probabilities":{"0":0.4,"1":0.6}}},
			"usage":{"input_tokens":42,"output_tokens":3}}`)
	})

	res, err := client.Decide(context.Background(), allKinds())
	if err != nil {
		t.Fatal(err)
	}

	if got.method != http.MethodPost || got.path != "/v1/systemone" {
		t.Errorf("request = %s %s, want POST /v1/systemone", got.method, got.path)
	}
	if got.auth != "Bearer key-123" || got.contentType != "application/json" {
		t.Errorf("headers: auth %q, content-type %q", got.auth, got.contentType)
	}
	if got.body["model"] != "jev-latest" || got.body["state"] != "rm -rf build" {
		t.Errorf("model/state = %v / %v", got.body["model"], got.body["state"])
	}
	questions := got.body["questions"].(map[string]any)
	safe := questions["safe"].(map[string]any)
	if safe["type"] != "noul" || safe["instructions"] != "The command is safe to run" {
		t.Errorf("yes/no question sent as %v", safe)
	}
	if _, has := safe["criteria"]; has {
		t.Errorf("yes/no question carries criteria: %v", safe)
	}
	kind := questions["kind"].(map[string]any)
	criteria := kind["criteria"].(map[string]any)
	if kind["type"] != "choice" || criteria["read"] != nil || criteria["delete"] != "removes files" {
		t.Errorf("choice question sent as %v (an option with no description must be null)", kind)
	}
	if _, present := criteria["read"]; !present {
		t.Errorf("an undescribed option was dropped instead of sent as null: %v", criteria)
	}
	risk := questions["risk"].(map[string]any)
	levels := risk["criteria"].([]any)
	if risk["type"] != "score" || len(levels) != 2 || levels[0] != "harmless" || levels[1] != "dangerous" {
		t.Errorf("score question sent as %v", risk)
	}

	if res.Answers["safe"].Probability != 0.97 || res.Answers["safe"].Kind != provider.QuestionYesNo {
		t.Errorf("yes/no answer = %+v", res.Answers["safe"])
	}
	if a := res.Answers["kind"]; a.Choice != "delete" || a.Confidence != 0.8 || a.Probabilities["read"] != 0.2 {
		t.Errorf("choice answer = %+v", a)
	}
	if a := res.Answers["risk"]; a.Score != 0.6 || a.Probabilities["1"] != 0.6 {
		t.Errorf("score answer = %+v", a)
	}
	if res.Usage.InputTokens != 42 || res.Usage.OutputTokens != 3 {
		t.Errorf("usage = %+v", res.Usage)
	}
}

func TestDecideRejectsAnswersThatDoNotMatchTheQuestion(t *testing.T) {
	yesNo := provider.DecisionRequest{State: "x", Questions: []provider.Question{{ID: "q", Kind: provider.QuestionYesNo, Instructions: "i"}}}
	choice := provider.DecisionRequest{State: "x", Questions: []provider.Question{{ID: "q", Kind: provider.QuestionChoice, Instructions: "i", Options: []provider.QuestionOption{{Name: "a"}, {Name: "b"}}}}}
	score := provider.DecisionRequest{State: "x", Questions: []provider.Question{{ID: "q", Kind: provider.QuestionScore, Instructions: "i", Options: []provider.QuestionOption{{Description: "lo"}, {Description: "hi"}}}}}

	cases := map[string]struct {
		req   provider.DecisionRequest
		reply string
	}{
		"missing answer":            {yesNo, `{"answers":{"other":{"type":"noul","noul":0.5}},"usage":{}}`},
		"wrong type":                {yesNo, `{"answers":{"q":{"type":"choice","choice":"a"}},"usage":{}}`},
		"yes/no without noul":       {yesNo, `{"answers":{"q":{"type":"noul"}},"usage":{}}`},
		"probability above one":     {yesNo, `{"answers":{"q":{"type":"noul","noul":1.5}},"usage":{}}`},
		"probability below zero":    {yesNo, `{"answers":{"q":{"type":"noul","noul":-0.1}},"usage":{}}`},
		"choice outside options":    {choice, `{"answers":{"q":{"type":"choice","choice":"c"}},"usage":{}}`},
		"score without a score":     {score, `{"answers":{"q":{"type":"score"}},"usage":{}}`},
		"score above the top level": {score, `{"answers":{"q":{"type":"score","score":1.5}},"usage":{}}`},
		"not json":                  {yesNo, `nope`},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, c.reply) })
			if res, err := client.Decide(context.Background(), c.req); err == nil {
				t.Fatalf("accepted %s, result %+v", c.reply, res)
			}
		})
	}
}

func TestDecideMapsStatusesToTypedErrors(t *testing.T) {
	respond := func(status int, header http.Header, body string) *Client {
		return newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			for k, v := range header {
				w.Header()[k] = v
			}
			w.WriteHeader(status)
			_, _ = io.WriteString(w, body)
		})
	}
	req := provider.DecisionRequest{State: "x", Questions: []provider.Question{{ID: "q", Kind: provider.QuestionYesNo, Instructions: "i"}}}

	var auth *provider.AuthError
	_, err := respond(http.StatusUnauthorized, nil, `{"error":"bad key"}`).Decide(context.Background(), req)
	if !errors.As(err, &auth) || auth.Provider != Name || auth.Status != 401 || auth.Hint == "" {
		t.Errorf("401 gave %v, want an AuthError naming the provider", err)
	}

	var limited *provider.RateLimitedError
	_, err = respond(http.StatusTooManyRequests, http.Header{"Retry-After": {"7"}}, `{}`).Decide(context.Background(), req)
	if !errors.As(err, &limited) || limited.RetryAfter != 7*time.Second {
		t.Errorf("429 gave %v, want a RateLimitedError that waits 7s", err)
	}

	_, err = respond(529, nil, `{}`).Decide(context.Background(), req)
	if got := provider.ClassifyFailure(err).Kind; got != provider.FailureOverloaded {
		t.Errorf("529 gave %v (%v), want an overloaded failure", err, got)
	}

	_, err = respond(http.StatusUnprocessableEntity, nil, `{"detail":"missing field"}`).Decide(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "422") || !strings.Contains(err.Error(), "missing field") {
		t.Errorf("422 gave %v, want the status and the body", err)
	}
	if got := provider.ClassifyFailure(err).Kind; got != provider.FailureInvalidRequest {
		t.Errorf("a validation failure was classed %v, want invalid-request: %v", got, err)
	}
}

func TestDecideValidatesBeforeSending(t *testing.T) {
	called := false
	client := newTestClient(t, func(http.ResponseWriter, *http.Request) { called = true })
	if _, err := client.Decide(context.Background(), provider.DecisionRequest{State: "x"}); err == nil {
		t.Fatal("a request with no questions was sent")
	}
	if called {
		t.Fatal("a malformed request reached the network")
	}

	noModel := New(provider.Config{APIKey: "k"})
	if _, err := noModel.Decide(context.Background(), allKinds()); err == nil {
		t.Fatal("a request with no model was accepted")
	}
}

func TestDecideHonoursContextCancellation(t *testing.T) {
	release := make(chan struct{})
	client := newTestClient(t, func(http.ResponseWriter, *http.Request) { <-release })
	defer close(release)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := client.Decide(ctx, allKinds()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the context deadline", err)
	}
}

func TestListModelsUsesTheCatalogueForWindows(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer key-123" {
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"models":[
			{"name":"jev-latest","description":"General-purpose system one model.","release_date":"2026-09-15"},
			{"name":"jev-2.0.0","description":"future","release_date":"2027-01-01"},
			{"name":"","description":"nameless","release_date":"2027-01-01"}]}`)
	})

	models, err := client.ListModelsWithInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("listed %d models, want 2 (the nameless one is dropped): %+v", len(models), models)
	}
	if models[0].ID != "jev-latest" || models[0].ContextWindow != 64000 || models[0].WindowAssumed {
		t.Errorf("catalogued model = %+v", models[0])
	}
	if models[1].ID != "jev-2.0.0" || models[1].ContextWindow != DefaultContextWindow || !models[1].WindowAssumed {
		t.Errorf("uncatalogued model = %+v, want the default window marked assumed", models[1])
	}
}

func TestListModelsReportsAuthFailure(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "no", http.StatusUnauthorized) })
	_, err := client.ListModelsWithInfo(context.Background())
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err = %v, want it to carry the 401", err)
	}
}

func TestRegisteredAsADecisionOnlyProvider(t *testing.T) {
	Register()
	t.Cleanup(func() { provider.UnregisterProvider(Name) })

	info, ok := provider.GetProviderInfo(Name)
	if !ok {
		t.Fatal("provider not registered")
	}
	if !info.Decisions || !info.DecisionOnly || info.Chats() {
		t.Errorf("info = %+v, want a decisions-only provider", info)
	}
	if info.ConfigKeyName == "" || info.EnvVarName != "TYPESAFE_API_KEY" {
		t.Errorf("credentials: key %q, env %q", info.ConfigKeyName, info.EnvVarName)
	}

	initialized, err := provider.InitializeProvider(Name, provider.Config{
		APIKey: "k", Model: "jev-latest", ModelCapabilities: provider.ModelCapabilities{ContextWindowTokens: 64000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := provider.As[provider.Decider](initialized); !ok {
		t.Error("the initialized provider cannot decide")
	}
	if _, ok := provider.As[provider.ConversationProvider](initialized); ok {
		t.Error("the initialized provider claims to chat")
	}
}

func TestCatalogueResolvesEveryListedModel(t *testing.T) {
	for id, window := range ModelContextWindows {
		caps, ok := resolveCapabilities(id)
		if !ok || caps.ContextWindowTokens != int64(window) {
			t.Errorf("%s: resolver gave %+v, %v for a catalogued window of %d", id, caps, ok, window)
		}
		// The API bounds the state plus any one question at 32k as well as the
		// whole request at 64k; admission can only enforce what it is told.
		if caps.QuestionContextTokens != QuestionContextWindow {
			t.Errorf("%s: per-question limit %d, want %d", id, caps.QuestionContextTokens, QuestionContextWindow)
		}
	}
	if _, ok := resolveCapabilities("jev-unknown"); ok {
		t.Error("an uncatalogued model resolved capabilities, so admission would not fail closed")
	}
}
