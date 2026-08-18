package dict

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Claude generates dictionary entries with the Messages API.
//
// The whole batch goes in one request: the words come from the same subtitle
// line, so sending them together lets the model disambiguate them against each
// other instead of guessing each one in isolation.
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

const dictSystemPrompt = `You are a bilingual dictionary for a subtitle-based language-learning app.

For each requested word you produce one dictionary entry, written for a learner
whose native language is the target language.

Rules:
- Return exactly one entry per requested word, in the same order.
- "headword" is the dictionary (lemma) form of the word, written in the source language.
- "reading" is the pronunciation of the headword in hiragana (Japanese source only).
  Leave it empty when the headword has no kanji, or when the source language is not Japanese.
- "pos" is the part of speech, written in the target language (e.g. 명사, 동사, 형용사, 조사, 부사).
- "jlpt" is the JLPT level of a Japanese headword ("N5".."N1"), or empty when it does not apply
  or you are not confident.
- "senses" lists the word's common meanings, most frequent first, at most 4.
  Each gloss is a short target-language equivalent — dictionary style, not a sentence.
  Split real homographs into separate senses (Japanese ぶん: 文 / 分 / 分 as a suffix).
  Add "note" only when a sense needs disambiguation (the kanji it is written with, a register mark).
- "in_context" is the single meaning the word carries in the provided line, in the target language.
  A few words, not a sentence. Leave empty when no context was given.
- "context_note" explains in the target language, in one or two sentences, how the word functions
  in this specific line — the nuance, the grammar role, why this form was chosen, or that it is a
  name, nickname, or set phrase. This is the field a learner reads to understand the line.
- "examples" gives at most 2 short natural sentences in the source language using the headword
  with this meaning, each with its target-language translation. Skip examples for particles and
  purely grammatical words.
- Never leave "senses" empty for a real word. If the token is punctuation, a filler sound, or a
  fragment with no meaning, return the entry with empty senses and explain that in context_note.`

var dictSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"entries": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"headword": map[string]any{"type": "string"},
					"reading":  map[string]any{"type": "string"},
					"pos":      map[string]any{"type": "string"},
					"jlpt":     map[string]any{"type": "string"},
					"senses": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"pos":   map[string]any{"type": "string"},
								"gloss": map[string]any{"type": "string"},
								"note":  map[string]any{"type": "string"},
							},
							"required":             []string{"gloss"},
							"additionalProperties": false,
						},
					},
					"in_context":   map[string]any{"type": "string"},
					"context_note": map[string]any{"type": "string"},
					"examples": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"text":        map[string]any{"type": "string"},
								"translation": map[string]any{"type": "string"},
							},
							"required":             []string{"text"},
							"additionalProperties": false,
						},
					},
				},
				"required":             []string{"headword", "senses"},
				"additionalProperties": false,
			},
		},
	},
	"required":             []string{"entries"},
	"additionalProperties": false,
}

func (c *Claude) Lookup(ctx context.Context, src, tgt, level string, reqs []Request) ([]Entry, error) {
	if len(reqs) == 0 {
		return nil, nil
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Source language: %s\nTarget language: %s\n", src, tgt)
	if level != "" {
		fmt.Fprintf(&b, "Learner level: JLPT %s\n", level)
	}
	b.WriteString("\nWords:\n")
	for i, r := range reqs {
		fmt.Fprintf(&b, "%d. word: %s\n", i+1, r.Surface)
		if r.Lemma != "" && r.Lemma != r.Surface {
			fmt.Fprintf(&b, "   analyzer lemma: %s\n", r.Lemma)
		}
		if r.Reading != "" {
			fmt.Fprintf(&b, "   analyzer reading: %s\n", r.Reading)
		}
		if r.POS != "" {
			fmt.Fprintf(&b, "   analyzer pos: %s\n", r.POS)
		}
		if r.Context != "" {
			fmt.Fprintf(&b, "   line: %s\n", r.Context)
		}
	}

	resp, err := c.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     c.model,
		MaxTokens: 8000,
		System:    []anthropic.TextBlockParam{{Text: dictSystemPrompt}},
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock(b.String())),
		},
		OutputConfig: anthropic.OutputConfigParam{
			Format: anthropic.JSONOutputFormatParam{Schema: dictSchema},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("anthropic request: %w", err)
	}
	if resp.StopReason == anthropic.StopReasonRefusal {
		return nil, fmt.Errorf("dictionary lookup refused: %s", resp.StopDetails.Explanation)
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
		Entries []Entry `json:"entries"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("decode dictionary payload: %w", err)
	}
	if len(parsed.Entries) != len(reqs) {
		return nil, errCount(len(parsed.Entries), len(reqs))
	}

	// The analyzer knows the surface for certain; the model only infers it.
	for i := range parsed.Entries {
		if parsed.Entries[i].Headword == "" {
			parsed.Entries[i].Headword = firstNonEmpty(reqs[i].Lemma, reqs[i].Surface)
		}
	}
	return parsed.Entries, nil
}
