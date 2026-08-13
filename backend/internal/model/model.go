// Package model holds the shared domain types.
package model

import "time"

// Source records where a saved expression came from. Platform is "youtube" or
// "netflix" — the two site adapters the extension supports.
type Source struct {
	Platform  string  `json:"platform"`
	ContentID string  `json:"content_id"`
	Title     string  `json:"title,omitempty"`
	TimeSec   float64 `json:"time_sec,omitempty"`
}

// Expression is a word or phrase the learner saved while watching.
type Expression struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Surface   string    `json:"surface"`
	Reading   string    `json:"reading,omitempty"`
	Gloss     string    `json:"gloss,omitempty"`
	JLPT      string    `json:"jlpt,omitempty"`
	Context   string    `json:"context,omitempty"`
	Source    Source    `json:"source"`
	CreatedAt time.Time `json:"created_at"`
}

// Token is one morpheme of an analyzed Japanese sentence.
//
// Start and End are offsets in UTF-16 code units, not bytes or runes, so that
// JavaScript can slice the original string with them directly.
type Token struct {
	Surface   string `json:"surface"`
	Reading   string `json:"reading,omitempty"`
	Lemma     string `json:"lemma,omitempty"`
	POS       string `json:"pos,omitempty"`
	JLPT      string `json:"jlpt,omitempty"`
	Gloss     string `json:"gloss,omitempty"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Highlight bool   `json:"highlight"`
}

// Analysis is the tokenization of a single input sentence.
type Analysis struct {
	Text   string  `json:"text"`
	Tokens []Token `json:"tokens"`
}

// ShadowingMetrics are measurements the client can make without uploading the
// learner's voice. A specialised pronunciation provider can later add phoneme
// and pitch data without changing the attempt lifecycle.
type ShadowingMetrics struct {
	ReferenceDuration float64 `json:"reference_duration"`
	RecordingDuration float64 `json:"recording_duration"`
	OnsetSec          float64 `json:"onset_sec"`
	SpeechRatio       float64 `json:"speech_ratio"`
	RecognizedText    string  `json:"recognized_text,omitempty"`
}

// ScoreBreakdown keeps a single total from hiding what the learner should do
// next. Text is omitted when browser speech recognition was unavailable.
type ScoreBreakdown struct {
	TextMatch *int `json:"text_match,omitempty"`
	Timing    int  `json:"timing"`
	Delivery  int  `json:"delivery"`
}

// ShadowingAttempt is one completed listen-and-repeat exercise.
type ShadowingAttempt struct {
	ID            string           `json:"id"`
	UserID        string           `json:"user_id"`
	SourceLang    string           `json:"source_lang"`
	TargetLang    string           `json:"target_lang"`
	Text          string           `json:"text"`
	Translation   string           `json:"translation,omitempty"`
	Start         float64          `json:"start"`
	End           float64          `json:"end"`
	Source        Source           `json:"source"`
	Metrics       ShadowingMetrics `json:"metrics"`
	Score         int              `json:"score"`
	Provisional   bool             `json:"provisional"`
	Breakdown     ScoreBreakdown   `json:"breakdown"`
	Feedback      []string         `json:"feedback"`
	PracticeHints []string         `json:"practice_hints,omitempty"`
	ReviewOf      string           `json:"review_of,omitempty"`
	Mode          string           `json:"mode,omitempty"`
	SelfRating    string           `json:"self_rating,omitempty"`
	ReviewCount   int              `json:"review_count"`
	DueAt         time.Time        `json:"due_at,omitempty"`
	CreatedAt     time.Time        `json:"created_at"`
}
