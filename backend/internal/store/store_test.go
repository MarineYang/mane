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

func TestListExpressionsFiltersBeforePagination(t *testing.T) {
	s := NewMemory()
	dayOne := time.Date(2026, 8, 13, 2, 0, 0, 0, time.UTC)
	dayTwo := dayOne.Add(24 * time.Hour)
	s.expressions["u1"] = []model.Expression{
		{ID: "word-old", UserID: "u1", Kind: model.ExpressionKindWord, Surface: "勉強", CreatedAt: dayOne},
		{ID: "sentence", UserID: "u1", Kind: model.ExpressionKindSentence, Surface: "勉強します。", CreatedAt: dayTwo},
		// Legacy expressions without kind remain visible as words.
		{ID: "word-legacy", UserID: "u1", Surface: "学校", CreatedAt: dayTwo.Add(time.Hour)},
	}

	items, total, err := s.List(context.Background(), "u1", ExpressionFilter{
		Kind: model.ExpressionKindWord,
		From: dayTwo,
		To:   dayTwo.Add(24 * time.Hour),
	}, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(items) != 1 || items[0].ID != "word-legacy" {
		t.Fatalf("items=%+v total=%d", items, total)
	}
	if items[0].Kind != model.ExpressionKindWord {
		t.Fatalf("legacy kind=%q", items[0].Kind)
	}
}
