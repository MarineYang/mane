package translate

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Claude translates subtitle cues with the Anthropic Messages API.
//
// Two choices worth knowing about:
//   - Structured outputs (output_config.format) constrain the reply to a JSON
//     array, so we never parse prose.
//   - Cues are sent as a numbered batch in one request. Subtitle lines are
//     fragments — translating them individually loses the context that makes
//     the Korean line read naturally.
type Claude struct {
	client anthropic.Client
	model  anthropic.Model
}

func NewClaude(apiKey, model string) *Claude {
	var opts []option.RequestOption
	if apiKey != "" {
		opts = append(opts, option.WithAPIKey(apiKey))
	}
	return &Claude{client: anthropic.NewClient(opts...), model: anthropic.Model(model)}
}

func (c *Claude) Name() string { return "claude:" + string(c.model) }

const systemPrompt = `You translate subtitle lines for a Korean-Japanese language-learning app.

Translate each numbered line from the source language to the target language.

Rules:
- Return exactly one translation per input line, in the same order.
- Subtitle lines are fragments of continuous dialogue. Use the surrounding lines as context, but translate each line on its own — never merge or split lines.
- Preserve the register of the original: casual speech stays casual, formal stays formal.
- For Korean and Japanese, preserve speech level, honorific nuance, and conversational omissions naturally.
- Keep proper nouns as they are conventionally written in the target language.
- If a line has no translatable content (music cues, sound effects), return it unchanged.`

var translationSchema = map[string]any{
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

func (c *Claude) Translate(ctx context.Context, sourceLang, targetLang string, texts []string) ([]string, error) {
	if len(texts) == 0 {
		return nil, nil
	}

	var b []byte
	b = append(b, fmt.Sprintf("Source language: %s\nTarget language: %s\n\nLines:\n", sourceLang, targetLang)...)
	for i, t := range texts {
		b = append(b, fmt.Sprintf("%d. %s\n", i+1, t)...)
	}

	resp, err := c.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     c.model,
		MaxTokens: 16000,
		System:    []anthropic.TextBlockParam{{Text: systemPrompt}},
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock(string(b))),
		},
		OutputConfig: anthropic.OutputConfigParam{
			Format: anthropic.JSONOutputFormatParam{Schema: translationSchema},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("anthropic request: %w", err)
	}

	// A refusal is a successful HTTP response with an empty or partial body,
	// so it has to be checked before reading content.
	if resp.StopReason == anthropic.StopReasonRefusal {
		return nil, fmt.Errorf("translation refused: %s", resp.StopDetails.Explanation)
	}

	var raw string
	for _, block := range resp.Content {
		if text, ok := block.AsAny().(anthropic.TextBlock); ok {
			raw += text.Text
		}
	}
	if raw == "" {
		return nil, fmt.Errorf("empty response from model (stop_reason=%s)", resp.StopReason)
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
