package dict

import (
	"context"
	"path/filepath"
	"testing"
)

// fakeProvider records what actually reached the provider so the tests can
// assert on cache behaviour rather than on return values alone.
type fakeProvider struct {
	calls [][]Request
	reply func(Request) Entry
}

func (f *fakeProvider) Name() string { return "fake" }

func (f *fakeProvider) Lookup(_ context.Context, _, _, _ string, reqs []Request) ([]Entry, error) {
	f.calls = append(f.calls, reqs)
	out := make([]Entry, len(reqs))
	for i, r := range reqs {
		out[i] = f.reply(r)
	}
	return out, nil
}

func withSense(r Request) Entry {
	return Entry{Headword: r.Surface, Senses: []Sense{{Gloss: "뜻:" + r.Surface}}}
}

func TestCachedServesRepeatLookupsWithoutCallingProvider(t *testing.T) {
	provider := &fakeProvider{reply: withSense}
	cache := NewCached(provider)
	req := []Request{{Surface: "文", Context: "文を書く"}}

	if _, err := cache.Lookup(context.Background(), "ja", "ko", "N4", req); err != nil {
		t.Fatal(err)
	}
	entries, err := cache.Lookup(context.Background(), "ja", "ko", "N4", req)
	if err != nil {
		t.Fatal(err)
	}

	if len(provider.calls) != 1 {
		t.Fatalf("provider called %d times, want 1", len(provider.calls))
	}
	if !entries[0].Cached {
		t.Error("second lookup should be marked cached")
	}
	if entries[0].Senses[0].Gloss != "뜻:文" {
		t.Errorf("cached entry lost its senses: %+v", entries[0])
	}
}

// The same word in a different line is a different entry: the note and the
// "meaning here" are what the learner reads, and they are context-specific.
func TestCachedTreatsNewContextAsMiss(t *testing.T) {
	provider := &fakeProvider{reply: withSense}
	cache := NewCached(provider)

	base := Request{Surface: "ぶん"}
	first := base
	first.Context = "文を書く"
	second := base
	second.Context = "ぶんちゃん…"

	ctx := context.Background()
	if _, err := cache.Lookup(ctx, "ja", "ko", "N4", []Request{first}); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Lookup(ctx, "ja", "ko", "N4", []Request{second}); err != nil {
		t.Fatal(err)
	}

	if len(provider.calls) != 2 {
		t.Fatalf("provider called %d times, want 2", len(provider.calls))
	}
}

// A lookup that produced nothing must stay retryable — caching the blank would
// make a transient failure permanent.
func TestCachedDoesNotMemoiseEmptyEntries(t *testing.T) {
	provider := &fakeProvider{reply: func(r Request) Entry {
		return Entry{Headword: r.Surface}
	}}
	cache := NewCached(provider)
	req := []Request{{Surface: "。", Context: "。"}}

	ctx := context.Background()
	if _, err := cache.Lookup(ctx, "ja", "ko", "N4", req); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Lookup(ctx, "ja", "ko", "N4", req); err != nil {
		t.Fatal(err)
	}

	if len(provider.calls) != 2 {
		t.Fatalf("provider called %d times, want 2", len(provider.calls))
	}
	if cache.Len() != 0 {
		t.Errorf("cache holds %d empty entries, want 0", cache.Len())
	}
}

func TestCacheFileSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dict.json")
	req := []Request{{Surface: "勉強", Context: "勉強しています"}}
	ctx := context.Background()

	first, err := NewCached(&fakeProvider{reply: withSense}).WithFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Lookup(ctx, "ja", "ko", "N4", req); err != nil {
		t.Fatal(err)
	}
	// Writes are asynchronous; flush synchronously for the assertion.
	if err := first.store.persist(first.snapshot()); err != nil {
		t.Fatal(err)
	}

	reloadedProvider := &fakeProvider{reply: withSense}
	second, err := NewCached(reloadedProvider).WithFile(path)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := second.Lookup(ctx, "ja", "ko", "N4", req)
	if err != nil {
		t.Fatal(err)
	}

	if len(reloadedProvider.calls) != 0 {
		t.Error("restart should not re-request an entry that was already paid for")
	}
	if entries[0].Senses[0].Gloss != "뜻:勉強" {
		t.Errorf("reloaded entry is wrong: %+v", entries[0])
	}
}
