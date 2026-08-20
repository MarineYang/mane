// Package llm holds provider clients that are shared by more than one feature.
//
// Translation and dictionary lookup both need the same thing from OpenAI: send a
// prompt, get back JSON that matches a schema. That plumbing lives here once
// rather than twice, so the feature packages stay about their own domain.
//
// Raw HTTP rather than the official SDK: the backend has exactly one OpenAI call
// shape, and the whole project so far carries no dependency it does not need.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const defaultOpenAIBaseURL = "https://api.openai.com/v1"

// OpenAI calls the Chat Completions API with a strict JSON schema.
//
// Structured outputs (response_format.json_schema with strict: true) are what
// make this usable as a backend: the reply is guaranteed to parse against the
// schema, so no prose-stripping or retry-on-parse loop is needed.
type OpenAI struct {
	apiKey  string
	model   string
	baseURL string
	client  *http.Client
}

func NewOpenAI(apiKey, model, baseURL string, timeout time.Duration) *OpenAI {
	if baseURL == "" {
		baseURL = defaultOpenAIBaseURL
	}
	return &OpenAI{
		apiKey:  apiKey,
		model:   model,
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{Timeout: timeout},
	}
}

func (c *OpenAI) Model() string { return c.model }

// JSON sends one request and returns the raw JSON body of the reply.
//
// @param schemaName  identifies the schema to the API; it appears in error messages
// @param schema      JSON Schema. Every object needs additionalProperties:false and
//
//	a required list naming every property — strict mode rejects
//	anything looser, including optional fields.
func (c *OpenAI) JSON(ctx context.Context, system, user, schemaName string, schema map[string]any) (string, error) {
	payload := map[string]any{
		"model": c.model,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		"response_format": map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   schemaName,
				"strict": true,
				"schema": schema,
			},
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("openai request: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	if resp.StatusCode != http.StatusOK {
		// Error bodies are {"error":{"message":...}}; surfacing the message beats
		// a bare status code when the cause is a bad key or an unknown model.
		var errBody struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &errBody) == nil && errBody.Error.Message != "" {
			return "", fmt.Errorf("openai %s: %s", resp.Status, errBody.Error.Message)
		}
		return "", fmt.Errorf("openai %s", resp.Status)
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
				Refusal string `json:"refusal"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("decode openai response: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("openai returned no choices")
	}

	choice := parsed.Choices[0]
	// A refusal is a 200 with an empty content field, so it has to be checked
	// before the content is read.
	if choice.Message.Refusal != "" {
		return "", fmt.Errorf("openai refused: %s", choice.Message.Refusal)
	}
	if choice.Message.Content == "" {
		return "", fmt.Errorf("empty response from openai (finish_reason=%s)", choice.FinishReason)
	}
	return choice.Message.Content, nil
}
