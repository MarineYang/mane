package dict

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
)

func errCount(got, want int) error {
	return fmt.Errorf("dictionary returned %d entries for %d words", got, want)
}

// fileCache persists the memoised entries so a restart does not throw away a
// dictionary that cost real API calls to build.
//
// Writes are temp-file + rename, and they happen off the request path: a
// lookup must not block on disk, and a lost final write only costs one repeat
// request.
type fileCache struct {
	path    string
	mu      sync.Mutex
	pending map[string]Entry
	dirty   bool
	writing bool
}

// WithFile attaches persistence at path, loading whatever is already there.
func (c *Cached) WithFile(path string) (*Cached, error) {
	if path == "" {
		return c, nil
	}
	store := &fileCache{path: filepath.Clean(path)}
	loaded, err := store.load()
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	for k, v := range loaded {
		c.cache[k] = v
	}
	c.mu.Unlock()
	c.store = store
	return c, nil
}

func (f *fileCache) load() (map[string]Entry, error) {
	data, err := os.ReadFile(f.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var state struct {
		Entries map[string]Entry `json:"entries"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("parse dictionary cache %s: %w", f.path, err)
	}
	return state.Entries, nil
}

// write schedules a flush. Concurrent calls collapse into one write of the
// latest snapshot rather than queueing up.
func (f *fileCache) write(snapshot map[string]Entry) {
	f.mu.Lock()
	f.pending = snapshot
	f.dirty = true
	if f.writing {
		f.mu.Unlock()
		return
	}
	f.writing = true
	f.mu.Unlock()

	go f.drain()
}

func (f *fileCache) drain() {
	for {
		f.mu.Lock()
		if !f.dirty {
			f.writing = false
			f.mu.Unlock()
			return
		}
		snapshot := f.pending
		f.dirty = false
		f.mu.Unlock()

		if err := f.persist(snapshot); err != nil {
			log.Printf("dictionary cache write failed: %v", err)
		}
	}
}

func (f *fileCache) persist(entries map[string]Entry) error {
	data, err := json.Marshal(struct {
		Entries map[string]Entry `json:"entries"`
	}{Entries: entries})
	if err != nil {
		return err
	}

	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".dict-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, f.path)
}
