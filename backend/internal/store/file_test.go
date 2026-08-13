package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

func TestFileStoreSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "langflix.json")
	first, err := NewFile(path)
	if err != nil {
		t.Fatal(err)
	}
	expression := &model.Expression{UserID: "u1", Surface: "勉強"}
	if err := first.Create(context.Background(), expression); err != nil {
		t.Fatal(err)
	}
	attempt := &model.ShadowingAttempt{
		UserID:     "u1",
		Text:       "日本語を勉強しています。",
		SelfRating: "good",
		DueAt:      time.Now().Add(time.Hour).UTC(),
	}
	if err := first.CreateAttempt(context.Background(), attempt); err != nil {
		t.Fatal(err)
	}

	second, err := NewFile(path)
	if err != nil {
		t.Fatal(err)
	}
	expressions, total, err := second.List(context.Background(), "u1", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(expressions) != 1 || expressions[0].Surface != "勉強" {
		t.Fatalf("expressions=%+v total=%d", expressions, total)
	}
	due, err := second.ListDueAttempts(context.Background(), "u1", time.Now().Add(2*time.Hour), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 || due[0].Text != attempt.Text {
		t.Fatalf("due=%+v", due)
	}
	if second.seq != first.seq {
		t.Fatalf("sequence after restart=%d want=%d", second.seq, first.seq)
	}
}

func TestFileStoreRejectsCorruptData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "broken.json")
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFile(path); err == nil {
		t.Fatal("corrupt file was accepted")
	}
}
