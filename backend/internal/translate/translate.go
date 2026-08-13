// Package translate turns Korean/Japanese subtitle cues into the learner's language.
//
// The PoC extension currently uses YouTube's own auto-translation for the
// second subtitle line. This package is what replaces it: context-aware LLM
// translation, cached so a re-watch never pays twice.
package translate

import (
	"context"
	"fmt"
	"sync"
)

// Translator converts a batch of texts. Batching matters — subtitle cues
// arrive by the hundreds and one request per cue would be unusable.
type Translator interface {
	Translate(ctx context.Context, sourceLang, targetLang string, texts []string) ([]string, error)
	Name() string
}

// Result carries the cache outcome so callers can see hit rate without
// instrumenting the cache itself.
type Result struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Cached bool   `json:"cached"`
}

// Stub is used when no API key is configured. It returns empty strings rather
// than an error so the rest of the pipeline stays end-to-end testable with zero
// configuration.
//
// It deliberately does NOT echo the source text: the UI stacks the translation
// under the original, so echoing renders every line twice and reads like a bug.
// An absent translation line is honest — /healthz reports translator="stub".
type Stub struct{}

func (Stub) Name() string { return "stub" }

func (Stub) Translate(_ context.Context, _, _ string, texts []string) ([]string, error) {
	return make([]string, len(texts)), nil
}

// Cached wraps a Translator with an in-process cache keyed by language pair
// and source text.
type Cached struct {
	inner Translator
	mu    sync.RWMutex
	cache map[string]string
}

func NewCached(inner Translator) *Cached {
	return &Cached{inner: inner, cache: make(map[string]string)}
}

func (c *Cached) Name() string { return c.inner.Name() }

// TranslateWithMeta resolves what it can from cache and sends only the misses
// downstream, preserving the caller's ordering.
func (c *Cached) TranslateWithMeta(ctx context.Context, src, tgt string, texts []string) ([]Result, error) {
	results := make([]Result, len(texts))
	var missIdx []int
	var missText []string

	c.mu.RLock()
	for i, t := range texts {
		if v, ok := c.cache[key(src, tgt, t)]; ok {
			results[i] = Result{Source: t, Target: v, Cached: true}
		} else {
			results[i] = Result{Source: t}
			missIdx = append(missIdx, i)
			missText = append(missText, t)
		}
	}
	c.mu.RUnlock()

	if len(missText) == 0 {
		return results, nil
	}

	translated, err := c.inner.Translate(ctx, src, tgt, missText)
	if err != nil {
		return nil, err
	}
	if len(translated) != len(missText) {
		return nil, fmt.Errorf("translator returned %d results for %d inputs", len(translated), len(missText))
	}

	c.mu.Lock()
	for n, i := range missIdx {
		results[i].Target = translated[n]
		c.cache[key(src, tgt, missText[n])] = translated[n]
	}
	c.mu.Unlock()

	return results, nil
}

func (c *Cached) Translate(ctx context.Context, src, tgt string, texts []string) ([]string, error) {
	res, err := c.TranslateWithMeta(ctx, src, tgt, texts)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(res))
	for i, r := range res {
		out[i] = r.Target
	}
	return out, nil
}

func key(src, tgt, text string) string { return src + "|" + tgt + "|" + text }
