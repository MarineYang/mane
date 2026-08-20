package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/marineyang/langflix-jp/backend/internal/llm"
)

// OpenAI translates subtitle cues with the Chat Completions API.
//
// Same contract and same batching rationale as the Claude translator: cues are
// fragments of one conversation, so they go up together and come back in order.
// Only the transport differs.
type OpenAI struct {
	client *llm.OpenAI
}

func NewOpenAI(apiKey, model, baseURL string, timeout time.Duration) *OpenAI {
	return &OpenAI{client: llm.NewOpenAI(apiKey, model, baseURL, timeout)}
}

func (o *OpenAI) Name() string { return "openai:" + o.client.Model() }

var openAITranslationSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"translations": map[string]any{
			"type":  "array",
			"items": map[string]any{"type": "string"},
		},
	},
	"required":             []string{"translations"},
	"additionalProperties": false,
}

func (o *OpenAI) Translate(ctx context.Context, sourceLang, targetLang string, texts []string) ([]string, error) {
	if len(texts) == 0 {
		return nil, nil
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Source language: %s\nTarget language: %s\n\nLines:\n", sourceLang, targetLang)
	for i, t := range texts {
		fmt.Fprintf(&b, "%d. %s\n", i+1, t)
	}

	raw, err := o.client.JSON(ctx, systemPrompt, b.String(), "subtitle_translations", openAITranslationSchema)
	if err != nil {
		return nil, err
	}

	var parsed struct {
		Translations []string `json:"translations"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("decode translation payload: %w", err)
	}
	if len(parsed.Translations) != len(texts) {
		return nil, fmt.Errorf("model returned %d translations for %d lines", len(parsed.Translations), len(texts))
	}
	return parsed.Translations, nil
}
