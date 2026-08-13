package store

import (
	"context"
	"testing"
	"time"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

func TestReviewHistoryWithoutDueDateDoesNotCreateDuplicateCard(t *testing.T) {
	s := NewMemory()
	original := &model.ShadowingAttempt{
		UserID: "u1",
		Text:   "今日はいい天気ですね。",
		DueAt:  time.Now().Add(time.Hour),
	}
	history := &model.ShadowingAttempt{
		UserID:   "u1",
		Text:     original.Text,
		ReviewOf: "attempt_previous",
		// 복습 이력은 자체 카드를 만들지 않으므로 DueAt이 비어 있다.
	}
	if err := s.CreateAttempt(context.Background(), original); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateAttempt(context.Background(), history); err != nil {
		t.Fatal(err)
	}

	due, err := s.ListDueAttempts(context.Background(), "u1", time.Now().Add(24*time.Hour), 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 || due[0].ID != original.ID {
		t.Fatalf("due=%+v", due)
	}
}
