//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package jev is the provider for TypeSafe's Jev, a decision model. Jev does not
// chat: it is given some text and questions about it and answers with
// probabilities and picks, never with generated text. So the provider is a
// provider.Decider and deliberately not a provider.ConversationProvider, and it
// is marked DecisionOnly so no chat picker offers its models.
package jev

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/httpx"
)

const (
	// Name is the registry name of the provider.
	Name = "jev"

	defaultBaseURL = "https://api.typesafe.ai/v1"

	// maxResponseBytes bounds what is read of any reply. A decision answers with
	// a few numbers per question, so this is generous; it only exists so a
	// misbehaving endpoint cannot be read into memory without end.
	maxResponseBytes = 4 << 20

	// maxErrorBytes bounds how much of an error body is quoted back.
	maxErrorBytes = 4096
)

// Register adds the Jev provider to the global registry. Called explicitly from
// the built-in list; no init()-time side effects.
func Register() {
	provider.RegisterProvider(provider.ProviderInfo{
		Name:          Name,
		DisplayName:   "Jev (TypeSafe)",
		Description:   msg.New("Jev, TypeSafe's decision model. It answers yes/no, choice and score questions with probabilities instead of writing text, so it is cheap and fast enough to judge things like tool approvals. It cannot be used for chat."),
		ConfigKeyName: "jev_api_key",
		// TypeSafe's own name for the variable, so a key already exported for its
		// SDKs is found without being typed in again.
		EnvVarName:               "TYPESAFE_API_KEY",
		APIKeyURL:                "https://console.typesafe.ai/keys",
		ModelContextWindows:      ModelContextWindows,
		ResolveModelCapabilities: resolveCapabilities,
		Decisions:                true,
		DecisionOnly:             true,
	}, func(cfg provider.Config) (provider.Provider, error) {
		return New(cfg), nil
	})
}

// Client talks to the Jev API.
type Client struct {
	apiKey  string
	model   string
	baseURL string
	headers map[string]string
	http    *http.Client
}

var (
	_ provider.Provider = (*Client)(nil)
	_ provider.Decider  = (*Client)(nil)
)

// New builds a Client from cfg. cfg.BaseURL, when set, replaces the endpoint.
func New(cfg provider.Config) *Client {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = defaultBaseURL
	}
	return &Client{
		apiKey:  cfg.APIKey,
		model:   cfg.Model,
		baseURL: base,
		headers: cfg.Headers,
		// No client-level timeout: the caller's context carries the deadline, and
		// a fixed one here would cut off a bound the caller chose to allow.
		http: httpx.Client(0),
	}
}

// Name returns the provider's registry name.
func (c *Client) Name() string { return Name }

// ListModelsWithInfo lists the models the key can use. The endpoint reports no
// limits, so each window comes from the catalogue, and a model it does not name
// is marked WindowAssumed.
func (c *Client) ListModelsWithInfo(ctx context.Context) ([]provider.ModelInfo, error) {
	var body struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := utils.GetJSON(ctx, c.baseURL+"/models", utils.JSONGetOptions{
		Bearer:  c.apiKey,
		Headers: c.headers,
		Label:   "Jev /models",
		Client:  httpx.Client(30 * time.Second),
	}, &body); err != nil {
		return nil, fmt.Errorf("failed to list models from Jev: %w", err)
	}

	models := make([]provider.ModelInfo, 0, len(body.Models))
	for _, m := range body.Models {
		if m.Name == "" {
			continue
		}
		window, catalogued := contextWindow(m.Name)
		models = append(models, provider.ModelInfo{
			ID:            m.Name,
			ContextWindow: window,
			WindowAssumed: !catalogued,
		})
	}
	return models, nil
}

// wireQuestion is a question as the API takes it.
type wireQuestion struct {
	Type         string `json:"type"`
	Instructions string `json:"instructions"`
	// Criteria is a name-to-description object for a choice, an ordered array of
	// level descriptions for a score, and absent for a yes/no.
	Criteria any `json:"criteria,omitempty"`
}

type wireRequest struct {
	Model     string                  `json:"model"`
	State     string                  `json:"state"`
	Questions map[string]wireQuestion `json:"questions"`
}

type wireAnswer struct {
	Type          string             `json:"type"`
	Noul          *float64           `json:"noul"`
	Choice        string             `json:"choice"`
	Score         *float64           `json:"score"`
	Confidence    float64            `json:"confidence"`
	Probabilities map[string]float64 `json:"probabilities"`
}

type wireResponse struct {
	Answers map[string]wireAnswer `json:"answers"`
	Usage   struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

// toWire translates a provider-neutral question into the API's.
func toWire(q provider.Question) wireQuestion {
	switch q.Kind {
	case provider.QuestionChoice:
		// An option with no description is sent as null, which the API reads as
		// "understood by its name alone".
		criteria := make(map[string]*string, len(q.Options))
		for _, o := range q.Options {
			if o.Description == "" {
				criteria[o.Name] = nil
				continue
			}
			criteria[o.Name] = &o.Description
		}
		return wireQuestion{Type: "choice", Instructions: q.Instructions, Criteria: criteria}
	case provider.QuestionScore:
		levels := make([]string, len(q.Options))
		for i, o := range q.Options {
			levels[i] = o.Description
		}
		return wireQuestion{Type: "score", Instructions: q.Instructions, Criteria: levels}
	default:
		return wireQuestion{Type: "noul", Instructions: q.Instructions}
	}
}

// Decide answers every question of req about req.State in one call.
func (c *Client) Decide(ctx context.Context, req provider.DecisionRequest) (provider.DecisionResult, error) {
	if err := req.Validate(); err != nil {
		return provider.DecisionResult{}, err
	}
	if c.model == "" {
		return provider.DecisionResult{}, fmt.Errorf("jev: no model selected")
	}

	wire := wireRequest{Model: c.model, State: req.State, Questions: make(map[string]wireQuestion, len(req.Questions))}
	for _, q := range req.Questions {
		wire.Questions[q.ID] = toWire(q)
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		return provider.DecisionResult{}, fmt.Errorf("jev: failed to encode request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/systemone", bytes.NewReader(payload))
	if err != nil {
		return provider.DecisionResult{}, fmt.Errorf("jev: failed to build request: %w", err)
	}
	for k, v := range c.headers {
		httpReq.Header.Set(k, v)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return provider.DecisionResult{}, fmt.Errorf("jev: request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBytes))
		return provider.DecisionResult{}, statusError(resp, strings.TrimSpace(string(raw)))
	}

	var decoded wireResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&decoded); err != nil {
		return provider.DecisionResult{}, fmt.Errorf("jev: failed to decode response: %w", err)
	}

	result := provider.DecisionResult{
		Answers: make(map[string]provider.Answer, len(req.Questions)),
		Usage:   provider.DecisionUsage{InputTokens: decoded.Usage.InputTokens, OutputTokens: decoded.Usage.OutputTokens},
	}
	for _, q := range req.Questions {
		wa, ok := decoded.Answers[q.ID]
		if !ok {
			return provider.DecisionResult{}, fmt.Errorf("jev: no answer for question %q", q.ID)
		}
		answer, err := fromWire(q, wa)
		if err != nil {
			return provider.DecisionResult{}, err
		}
		result.Answers[q.ID] = answer
	}
	return result, nil
}

// fromWire checks an answer against the question it belongs to and translates
// it. A reply that does not match its question is an error rather than a guess:
// a verdict built from a misread answer would be worse than none.
func fromWire(q provider.Question, a wireAnswer) (provider.Answer, error) {
	switch q.Kind {
	case provider.QuestionYesNo:
		if a.Type != "noul" || a.Noul == nil {
			return provider.Answer{}, fmt.Errorf("jev: answer to %q is not a yes/no probability", q.ID)
		}
		if p := *a.Noul; p < 0 || p > 1 {
			return provider.Answer{}, fmt.Errorf("jev: answer to %q has probability %v outside 0 to 1", q.ID, p)
		}
		return provider.Answer{Kind: q.Kind, Probability: *a.Noul}, nil

	case provider.QuestionChoice:
		if a.Type != "choice" {
			return provider.Answer{}, fmt.Errorf("jev: answer to %q is not a choice", q.ID)
		}
		for _, o := range q.Options {
			if o.Name == a.Choice {
				return provider.Answer{Kind: q.Kind, Choice: a.Choice, Confidence: a.Confidence, Probabilities: a.Probabilities}, nil
			}
		}
		return provider.Answer{}, fmt.Errorf("jev: answer to %q picked %q, which is not one of its options", q.ID, a.Choice)

	case provider.QuestionScore:
		if a.Type != "score" || a.Score == nil {
			return provider.Answer{}, fmt.Errorf("jev: answer to %q is not a score", q.ID)
		}
		if s := *a.Score; s < 0 || s > float64(len(q.Options)-1) {
			return provider.Answer{}, fmt.Errorf("jev: answer to %q scores %v, outside its %d levels", q.ID, s, len(q.Options))
		}
		return provider.Answer{Kind: q.Kind, Score: *a.Score, Confidence: a.Confidence, Probabilities: a.Probabilities}, nil
	}
	return provider.Answer{}, fmt.Errorf("jev: question %q has unknown kind %q", q.ID, q.Kind)
}

// statusError turns a non-200 reply into the typed error its status calls for,
// so callers can tell a bad key, a throttle and an overload apart without
// reading prose.
func statusError(resp *http.Response, body string) error {
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return &provider.AuthError{
			Provider: Name,
			Status:   resp.StatusCode,
			Message:  fmt.Sprintf("Jev rejected the API key (HTTP 401): %s", body),
			Hint:     "Check the Jev API key in Settings → Providers.",
		}
	case http.StatusTooManyRequests:
		return &provider.RateLimitedError{
			RetryAfter: utils.ParseRateLimitHint(resp.Header, body),
			Message:    fmt.Sprintf("Jev rate limit reached (HTTP 429): %s", body),
		}
	case 529:
		// "overloaded" is the marker the shared transient classifier retries on.
		return fmt.Errorf("jev is overloaded (HTTP 529), try again shortly: %s", body)
	}
	return fmt.Errorf("jev returned HTTP %d: %s", resp.StatusCode, body)
}
