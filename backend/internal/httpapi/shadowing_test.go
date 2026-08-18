package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/marineyang/langflix-jp/backend/internal/config"
	"github.com/marineyang/langflix-jp/backend/internal/dict"
	"github.com/marineyang/langflix-jp/backend/internal/model"
	"github.com/marineyang/langflix-jp/backend/internal/nlp"
	"github.com/marineyang/langflix-jp/backend/internal/store"
	"github.com/marineyang/langflix-jp/backend/internal/translate"
)

func testRouter() http.Handler {
	return New(
		config.Config{AllowedOrigins: []string{"*"}},
		translate.NewCached(translate.Stub{}),
		nlp.Stub{},
		dict.NewCached(dict.Stub{}),
		store.NewMemory(),
	).Router()
}

func requestJSON(t *testing.T, router http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	return res
}

func TestShadowingAttemptAndReviewLifecycle(t *testing.T) {
	router := testRouter()
	body := map[string]any{
		"source_lang": "ja",
		"target_lang": "ko",
		"text":        "ちょっと待って。",
		"start":       4,
		"end":         6,
		"source":      map[string]any{"platform": "youtube", "content_id": "demo"},
		"metrics": map[string]any{
			"reference_duration": 2,
			"recording_duration": 2.1,
			"onset_sec":          0.2,
			"speech_ratio":       0.8,
			"recognized_text":    "ちょっと待って",
		},
	}
	created := requestJSON(t, router, http.MethodPost, "/v1/shadowing/attempts", body)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var attempt model.ShadowingAttempt
	if err := json.Unmarshal(created.Body.Bytes(), &attempt); err != nil {
		t.Fatal(err)
	}
	if attempt.ID == "" || attempt.Score < 80 || attempt.Provisional {
		t.Fatalf("unexpected attempt: %+v", attempt)
	}

	future := time.Now().UTC().Add(72 * time.Hour).Format(time.RFC3339)
	due := requestJSON(t, router, http.MethodGet, "/v1/shadowing/reviews?due_before="+future, nil)
	if due.Code != http.StatusOK {
		t.Fatalf("due status=%d body=%s", due.Code, due.Body.String())
	}
	var list struct {
		Reviews []model.ShadowingAttempt `json:"reviews"`
	}
	if err := json.Unmarshal(due.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Reviews) != 1 {
		t.Fatalf("reviews=%d body=%s", len(list.Reviews), due.Body.String())
	}

	reviewed := requestJSON(
		t,
		router,
		http.MethodPost,
		"/v1/shadowing/attempts/"+attempt.ID+"/review",
		map[string]int{"score": 88},
	)
	if reviewed.Code != http.StatusOK {
		t.Fatalf("review status=%d body=%s", reviewed.Code, reviewed.Body.String())
	}
}

func TestShadowingAttemptRejectsInvalidDuration(t *testing.T) {
	res := requestJSON(t, testRouter(), http.MethodPost, "/v1/shadowing/attempts", map[string]any{
		"text":  "テストです。",
		"start": 2,
		"end":   1,
		"metrics": map[string]any{
			"recording_duration": 1,
		},
	})
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestShadowingSelfAssessmentNeedsNoMicrophoneMetrics(t *testing.T) {
	res := requestJSON(t, testRouter(), http.MethodPost, "/v1/shadowing/attempts", map[string]any{
		"source_lang": "ko",
		"target_lang": "ja",
		"text":        "오늘은 날씨가 좋네요.",
		"start":       1,
		"end":         4,
		"self_rating": "good",
	})
	if res.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var attempt model.ShadowingAttempt
	if err := json.Unmarshal(res.Body.Bytes(), &attempt); err != nil {
		t.Fatal(err)
	}
	if attempt.Mode != "self_assessment" || attempt.SelfRating != "good" || attempt.Score != 75 {
		t.Fatalf("unexpected attempt: %+v", attempt)
	}
	if attempt.DueAt.Before(time.Now().Add(70 * time.Hour)) {
		t.Fatalf("good rating due too soon: %v", attempt.DueAt)
	}
}
