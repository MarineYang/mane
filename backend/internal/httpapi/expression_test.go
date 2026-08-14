package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

func TestExpressionKindAndFilters(t *testing.T) {
	router := testRouter()

	word := requestJSON(t, router, http.MethodPost, "/v1/expressions", map[string]any{
		"surface": "勉強",
	})
	if word.Code != http.StatusCreated {
		t.Fatalf("word status=%d body=%s", word.Code, word.Body.String())
	}
	var savedWord model.Expression
	if err := json.Unmarshal(word.Body.Bytes(), &savedWord); err != nil {
		t.Fatal(err)
	}
	if savedWord.Kind != model.ExpressionKindWord {
		t.Fatalf("default kind=%q", savedWord.Kind)
	}

	sentence := requestJSON(t, router, http.MethodPost, "/v1/expressions", map[string]any{
		"kind":    "sentence",
		"surface": "日本語を勉強します。",
	})
	if sentence.Code != http.StatusCreated {
		t.Fatalf("sentence status=%d body=%s", sentence.Code, sentence.Body.String())
	}

	query := url.Values{}
	query.Set("kind", "sentence")
	query.Set("from", time.Now().UTC().Add(-time.Hour).Format(time.RFC3339))
	query.Set("to", time.Now().UTC().Add(time.Hour).Format(time.RFC3339))
	filtered := requestJSON(t, router, http.MethodGet, "/v1/expressions?"+query.Encode(), nil)
	if filtered.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", filtered.Code, filtered.Body.String())
	}
	var list struct {
		Expressions []model.Expression `json:"expressions"`
		Total       int                `json:"total"`
	}
	if err := json.Unmarshal(filtered.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.Total != 1 || len(list.Expressions) != 1 || list.Expressions[0].Kind != model.ExpressionKindSentence {
		t.Fatalf("list=%+v total=%d", list.Expressions, list.Total)
	}
}

func TestExpressionFiltersRejectInvalidValues(t *testing.T) {
	for _, path := range []string{
		"/v1/expressions?kind=paragraph",
		"/v1/expressions?from=yesterday",
		"/v1/expressions?from=2026-08-14T10:00:00Z&to=2026-08-14T09:00:00Z",
	} {
		res := requestJSON(t, testRouter(), http.MethodGet, path, nil)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("path=%s status=%d body=%s", path, res.Code, res.Body.String())
		}
	}
}
