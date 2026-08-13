// Package nlp analyzes Japanese text into morphemes.
//
// Japanese has no spaces, so morphological analysis is the prerequisite for
// every word-level feature: tappable words, furigana, JLPT highlighting, and
// dictionary lookups. The real work happens in the Python service (SudachiPy);
// this package is the interface plus a degraded fallback.
package nlp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"unicode"
	"unicode/utf16"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

type Analyzer interface {
	Analyze(ctx context.Context, texts []string, level string) ([]model.Analysis, error)
	Name() string
}

// Remote proxies to the Python NLP service.
type Remote struct {
	baseURL string
	client  *http.Client
}

func NewRemote(baseURL string, client *http.Client) *Remote {
	return &Remote{baseURL: baseURL, client: client}
}

func (r *Remote) Name() string { return "remote:" + r.baseURL }

func (r *Remote) Analyze(ctx context.Context, texts []string, level string) ([]model.Analysis, error) {
	payload, err := json.Marshal(map[string]any{"texts": texts, "level": level})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/analyze", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("nlp service unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("nlp service returned %s", resp.Status)
	}

	var body struct {
		Results []model.Analysis `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode nlp response: %w", err)
	}
	return body.Results, nil
}

// Stub segments text by character class (kanji / kana / latin / digits) when
// the Python service is not configured.
//
// This is NOT morphological analysis — it cannot find word boundaries inside a
// kanji run, and it produces no readings, JLPT levels, or glosses. It exists
// so the extension's highlight-and-save path can be exercised end to end
// before the NLP service is running.
type Stub struct{}

func (Stub) Name() string { return "stub" }

func (Stub) Analyze(_ context.Context, texts []string, _ string) ([]model.Analysis, error) {
	out := make([]model.Analysis, 0, len(texts))
	for _, text := range texts {
		out = append(out, model.Analysis{Text: text, Tokens: segment(text)})
	}
	return out, nil
}

type charClass int

const (
	classOther charClass = iota
	classKanji
	classHiragana
	classKatakana
	classLatin
	classDigit
)

func classify(r rune) charClass {
	switch {
	case unicode.Is(unicode.Han, r):
		return classKanji
	case unicode.Is(unicode.Hiragana, r):
		return classHiragana
	case unicode.Is(unicode.Katakana, r):
		return classKatakana
	case unicode.IsDigit(r):
		return classDigit
	case unicode.IsLetter(r):
		return classLatin
	default:
		return classOther
	}
}

// segment groups consecutive runes of the same character class. Offsets are
// counted in UTF-16 code units so JavaScript can slice with them directly.
func segment(text string) []model.Token {
	var tokens []model.Token
	var cur []rune
	curClass := classOther
	offset := 0
	start := 0

	flush := func() {
		if len(cur) == 0 {
			return
		}
		if curClass != classOther {
			tokens = append(tokens, model.Token{
				Surface: string(cur),
				Start:   start,
				End:     offset,
			})
		}
		cur = nil
	}

	for _, r := range text {
		c := classify(r)
		if c != curClass {
			flush()
			curClass = c
			start = offset
		}
		cur = append(cur, r)
		offset += utf16.RuneLen(r)
	}
	flush()

	return tokens
}
