package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestJSONSendsStrictSchemaAndReturnsContent(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Error(err)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-key" {
			t.Errorf("Authorization = %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"content":"{\"ok\":true}"}}]}`)
	}))
	defer server.Close()

	client := NewOpenAI("test-key", "gpt-test", server.URL, 5*time.Second)
	raw, err := client.JSON(context.Background(), "sys", "user", "thing", map[string]any{"type": "object"})
	if err != nil {
		t.Fatal(err)
	}
	if raw != `{"ok":true}` {
		t.Errorf("content = %q", raw)
	}

	format, _ := got["response_format"].(map[string]any)
	schema, _ := format["json_schema"].(map[string]any)
	// strict is what makes the reply parseable without a retry loop; if it ever
	// stops being sent, the failure would be intermittent and hard to place.
	if schema["strict"] != true {
		t.Errorf("json_schema.strict = %v, want true", schema["strict"])
	}
	if schema["name"] != "thing" {
		t.Errorf("json_schema.name = %v", schema["name"])
	}
}

// A refusal is a 200 with empty content — read as success it would surface as a
// confusing "no translations" error further up.
func TestJSONReportsRefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"choices":[{"message":{"content":"","refusal":"nope"}}]}`)
	}))
	defer server.Close()

	_, err := NewOpenAI("k", "m", server.URL, time.Second).
		JSON(context.Background(), "s", "u", "n", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("err = %v, want the refusal message", err)
	}
}

func TestJSONSurfacesAPIErrorMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, `{"error":{"message":"Incorrect API key provided"}}`)
	}))
	defer server.Close()

	_, err := NewOpenAI("bad", "m", server.URL, time.Second).
		JSON(context.Background(), "s", "u", "n", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "Incorrect API key") {
		t.Fatalf("err = %v, want the API error message", err)
	}
}
