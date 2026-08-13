// Package store persists saved expressions.
//
// Only an in-memory implementation exists today. The interface is here so the
// PostgreSQL implementation can be dropped in without touching the handlers.
package store

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

var ErrNotFound = errors.New("item not found")

type ExpressionStore interface {
	Create(ctx context.Context, e *model.Expression) error
	List(ctx context.Context, userID string, limit, offset int) ([]model.Expression, int, error)
	Delete(ctx context.Context, userID, id string) error
}

type ShadowingStore interface {
	CreateAttempt(ctx context.Context, a *model.ShadowingAttempt) error
	ListDueAttempts(ctx context.Context, userID string, dueBefore time.Time, limit int) ([]model.ShadowingAttempt, error)
	CompleteReview(ctx context.Context, userID, id string, score int, nextDue time.Time) (*model.ShadowingAttempt, error)
}

type Store interface {
	ExpressionStore
	ShadowingStore
}

type MemoryStore struct {
	mu          sync.RWMutex
	expressions map[string][]model.Expression
	attempts    map[string][]model.ShadowingAttempt
	seq         int64
}

func NewMemory() *MemoryStore {
	return &MemoryStore{
		expressions: make(map[string][]model.Expression),
		attempts:    make(map[string][]model.ShadowingAttempt),
	}
}

func (s *MemoryStore) Create(_ context.Context, e *model.Expression) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.seq++
	e.ID = fmt.Sprintf("exp_%d", s.seq)
	e.CreatedAt = time.Now().UTC()
	s.expressions[e.UserID] = append(s.expressions[e.UserID], *e)
	return nil
}

func (s *MemoryStore) List(_ context.Context, userID string, limit, offset int) ([]model.Expression, int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	all := s.expressions[userID]
	total := len(all)

	// Newest first — the extension saves as you watch, and the app shows the
	// most recent saves at the top of the library.
	sorted := make([]model.Expression, total)
	copy(sorted, all)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].CreatedAt.After(sorted[j].CreatedAt) })

	if offset >= total {
		return []model.Expression{}, total, nil
	}
	end := offset + limit
	if limit <= 0 || end > total {
		end = total
	}
	return sorted[offset:end], total, nil
}

func (s *MemoryStore) Delete(_ context.Context, userID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	list := s.expressions[userID]
	for i, e := range list {
		if e.ID == id {
			s.expressions[userID] = append(list[:i], list[i+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

func (s *MemoryStore) CreateAttempt(_ context.Context, a *model.ShadowingAttempt) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.seq++
	a.ID = fmt.Sprintf("attempt_%d", s.seq)
	a.CreatedAt = time.Now().UTC()
	s.attempts[a.UserID] = append(s.attempts[a.UserID], *a)
	return nil
}

func (s *MemoryStore) ListDueAttempts(_ context.Context, userID string, dueBefore time.Time, limit int) ([]model.ShadowingAttempt, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var due []model.ShadowingAttempt
	for _, a := range s.attempts[userID] {
		if !a.DueAt.IsZero() && !a.DueAt.After(dueBefore) {
			due = append(due, a)
		}
	}
	sort.Slice(due, func(i, j int) bool { return due[i].DueAt.Before(due[j].DueAt) })
	if limit > 0 && len(due) > limit {
		due = due[:limit]
	}
	return due, nil
}

func (s *MemoryStore) CompleteReview(_ context.Context, userID, id string, score int, nextDue time.Time) (*model.ShadowingAttempt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	list := s.attempts[userID]
	for i := range list {
		if list[i].ID != id {
			continue
		}
		list[i].Score = score
		list[i].ReviewCount++
		list[i].DueAt = nextDue
		s.attempts[userID] = list
		copy := list[i]
		return &copy, nil
	}
	return nil, ErrNotFound
}
