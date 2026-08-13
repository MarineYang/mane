package shadowing

import (
	"strings"
	"testing"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

func TestScoreUsesRecognizedTextWhenAvailable(t *testing.T) {
	score, provisional, breakdown, feedback, _ := Score(
		"日本語を勉強しています。",
		"ja",
		model.ShadowingMetrics{
			ReferenceDuration: 3,
			RecordingDuration: 3.1,
			OnsetSec:          0.15,
			SpeechRatio:       0.8,
			RecognizedText:    "日本語を勉強しています",
		},
	)
	if provisional {
		t.Fatal("음성 인식 결과가 있는데 provisional=true")
	}
	if breakdown.TextMatch == nil || *breakdown.TextMatch < 95 {
		t.Fatalf("text match = %v", breakdown.TextMatch)
	}
	if score < 90 {
		t.Fatalf("score = %d, feedback=%v", score, feedback)
	}
}

func TestScoreIsExplicitlyProvisionalWithoutASR(t *testing.T) {
	_, provisional, breakdown, feedback, _ := Score(
		"こんにちは",
		"ja",
		model.ShadowingMetrics{
			ReferenceDuration: 2,
			RecordingDuration: 2,
			OnsetSec:          0.2,
			SpeechRatio:       0.75,
		},
	)
	if !provisional {
		t.Fatal("ASR 없는 점수는 provisional 이어야 함")
	}
	if breakdown.TextMatch != nil {
		t.Fatal("ASR 없는데 text_match가 채워짐")
	}
	if len(feedback) == 0 {
		t.Fatal("임시 점수 설명이 없음")
	}
}

func TestScoreAddsJapanesePracticeHints(t *testing.T) {
	_, _, _, _, hints := Score(
		"ちょっと待って。",
		"ja",
		model.ShadowingMetrics{ReferenceDuration: 2, RecordingDuration: 2, SpeechRatio: 0.8},
	)
	if len(hints) == 0 {
		t.Fatal("촉음 문장에 연습 힌트가 없음")
	}
}

func TestPoorTimingLowersScore(t *testing.T) {
	good, _, _, _, _ := Score(
		"안녕하세요",
		"ko",
		model.ShadowingMetrics{ReferenceDuration: 2, RecordingDuration: 2, OnsetSec: 0.1, SpeechRatio: 0.8},
	)
	bad, _, _, _, _ := Score(
		"안녕하세요",
		"ko",
		model.ShadowingMetrics{ReferenceDuration: 2, RecordingDuration: 5, OnsetSec: 1.5, SpeechRatio: 0.2},
	)
	if good <= bad {
		t.Fatalf("good=%d bad=%d", good, bad)
	}
}

func TestKoreanPracticeHintsAreSentenceSpecific(t *testing.T) {
	hints := koreanPracticeHints("옷 입고 갑니다")
	var liaison bool
	for _, hint := range hints {
		if strings.Contains(hint, "연음") {
			liaison = true
		}
	}
	if !liaison {
		t.Fatalf("연음 구간을 찾지 못함: %v", hints)
	}
}

func TestDecomposeHangul(t *testing.T) {
	onset, vowel, tail, ok := decomposeHangul('한')
	if !ok || onset != 18 || vowel != 0 || tail != 4 {
		t.Fatalf("한 = onset:%d vowel:%d tail:%d ok:%v", onset, vowel, tail, ok)
	}
}
