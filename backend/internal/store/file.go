package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

// FileStore adds restart-safe persistence to MemoryStore for the local MVP.
// Writes use temp-file + fsync + rename so a crash cannot leave half a JSON
// document behind. PostgreSQL can still replace it through the Store interface.
type FileStore struct {
	*MemoryStore
	path    string
	writeMu sync.Mutex
}

type fileState struct {
	Expressions map[string][]model.Expression       `json:"expressions"`
	Attempts    map[string][]model.ShadowingAttempt `json:"shadowing_attempts"`
	Sequence    int64                               `json:"sequence"`
}

func NewFile(path string) (*FileStore, error) {
	if path == "" {
		return nil, errors.New("data file path is required")
	}
	memory := NewMemory()
	s := &FileStore{MemoryStore: memory, path: filepath.Clean(path)}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *FileStore) load() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var state fileState
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}
	if state.Expressions != nil {
		s.expressions = state.Expressions
	}
	if state.Attempts != nil {
		s.attempts = state.Attempts
	}
	s.seq = state.Sequence
	return nil
}

func (s *FileStore) Create(ctx context.Context, expression *model.Expression) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.MemoryStore.Create(ctx, expression); err != nil {
		return err
	}
	return s.persist()
}

func (s *FileStore) Delete(ctx context.Context, userID, id string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.MemoryStore.Delete(ctx, userID, id); err != nil {
		return err
	}
	return s.persist()
}

func (s *FileStore) CreateAttempt(ctx context.Context, attempt *model.ShadowingAttempt) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.MemoryStore.CreateAttempt(ctx, attempt); err != nil {
		return err
	}
	return s.persist()
}

func (s *FileStore) CompleteReview(ctx context.Context, userID, id string, score int, nextDue time.Time) (*model.ShadowingAttempt, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	attempt, err := s.MemoryStore.CompleteReview(ctx, userID, id, score, nextDue)
	if err != nil {
		return nil, err
	}
	if err := s.persist(); err != nil {
		return nil, err
	}
	return attempt, nil
}

func (s *FileStore) persist() error {
	s.mu.RLock()
	state := fileState{
		Expressions: cloneExpressions(s.expressions),
		Attempts:    cloneAttempts(s.attempts),
		Sequence:    s.seq,
	}
	s.mu.RUnlock()

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".langflix-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)

	encoder := json.NewEncoder(temp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(state); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, s.path)
}

func cloneExpressions(source map[string][]model.Expression) map[string][]model.Expression {
	out := make(map[string][]model.Expression, len(source))
	for userID, items := range source {
		out[userID] = append([]model.Expression(nil), items...)
	}
	return out
}

func cloneAttempts(source map[string][]model.ShadowingAttempt) map[string][]model.ShadowingAttempt {
	out := make(map[string][]model.ShadowingAttempt, len(source))
	for userID, items := range source {
		copies := make([]model.ShadowingAttempt, len(items))
		copy(copies, items)
		for i := range copies {
			copies[i].Feedback = append([]string(nil), items[i].Feedback...)
			copies[i].PracticeHints = append([]string(nil), items[i].PracticeHints...)
		}
		out[userID] = copies
	}
	return out
}
