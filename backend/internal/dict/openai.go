package dict

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/marineyang/langflix-jp/backend/internal/llm"
)

// OpenAI generates dictionary entries with the Chat Completions API.
//
// Shares dictSystemPrompt with the Claude provider so the two produce the same
// shape of entry — swapping providers must not change what the tooltip renders.
type OpenAI struct {
	client *llm.OpenAI
}

func NewOpenAI(apiKey, model, baseURL string, timeout time.Duration) *OpenAI {
	return &OpenAI{client: llm.NewOpenAI(apiKey, model, baseURL, timeout)}
}

func (o *OpenAI) Name() string { return "openai:" + o.client.Model() }

// OpenAI strict mode requires every property to appear in `required` and every
// object to set additionalProperties:false — there is no optional field. So the
// schema asks for all of them and the model returns "" or [] where a field does
// not apply, which the client already treats as absent.
var openAIDictSchema = map[string]any{
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
							"required":             []string{"pos", "gloss", "note"},
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
							"required":             []string{"text", "translation"},
							"additionalProperties": false,
						},
					},
				},
				"required": []string{
					"headword", "reading", "pos", "jlpt",
					"senses", "in_context", "context_note", "examples",
				},
				"additionalProperties": false,
			},
		},
	},
	"required":             []string{"entries"},
	"additionalProperties": false,
}

func (o *OpenAI) Lookup(ctx context.Context, src, tgt, level string, reqs []Request) ([]Entry, error) {
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

	raw, err := o.client.JSON(ctx, dictSystemPrompt, b.String(), "dictionary_entries", openAIDictSchema)
	if err != nil {
		return nil, err
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

	for i := range parsed.Entries {
		if parsed.Entries[i].Headword == "" {
			parsed.Entries[i].Headword = firstNonEmpty(reqs[i].Lemma, reqs[i].Surface)
		}
	}
	return parsed.Entries, nil
}
