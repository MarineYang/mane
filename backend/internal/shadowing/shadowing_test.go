package shadowing

import (
	"testing"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

func texts(sentences []Sentence) []string {
	out := make([]string, len(sentences))
	for i, s := range sentences {
		out[i] = s.Text
	}
	return out
}

func TestMergeSplitsOnSentenceEnd(t *testing.T) {
	// A sentence spread over two cues should come back as one.
	got := MergeCues([]Cue{
		{Start: 0, End: 2, Text: "しかし海外で働く"},
		{Start: 2, End: 4, Text: "外国人から聞こえてきた。"},
		{Start: 4, End: 6, Text: "次の文です。"},
	})

	want := []string{"しかし海外で働く外国人から聞こえてきた。", "次の文です。"}
	if len(got) != len(want) {
		t.Fatalf("문장 수 = %d, 기대 %d: %v", len(got), len(want), texts(got))
	}
	for i := range want {
		if got[i].Text != want[i] {
			t.Errorf("[%d] = %q, 기대 %q", i, got[i].Text, want[i])
		}
	}
}

func TestMergeSplitsOnGapWithoutPunctuation(t *testing.T) {
	// Auto-generated tracks carry no punctuation, so a pause is the only
	// signal that one utterance ended and another began.
	got := MergeCues([]Cue{
		{Start: 0, End: 2, Text: "高い給料を"},
		{Start: 2, End: 4, Text: "求めるなら"},
		{Start: 10, End: 12, Text: "日本で働くべきじゃない"},
	})

	if len(got) != 2 {
		t.Fatalf("문장 수 = %d, 기대 2: %v", len(got), texts(got))
	}
	if got[0].Text != "高い給料を求めるなら" {
		t.Errorf("첫 문장 = %q", got[0].Text)
	}
}

func TestMergePreservesTiming(t *testing.T) {
	// A merged sentence must still be replayable, so it spans the first cue's
	// start to the last cue's end.
	got := MergeCues([]Cue{
		{Start: 1.5, End: 3.0, Text: "これは"},
		{Start: 3.0, End: 5.25, Text: "テストです。"},
	})

	if len(got) != 1 {
		t.Fatalf("문장 수 = %d, 기대 1", len(got))
	}
	if got[0].Start != 1.5 || got[0].End != 5.25 {
		t.Errorf("구간 = [%v, %v], 기대 [1.5, 5.25]", got[0].Start, got[0].End)
	}
}

func TestMergeKoreanCuesPreservesWordBoundary(t *testing.T) {
	got := MergeCuesForLanguage([]Cue{
		{Start: 0, End: 1, Text: "오늘은"},
		{Start: 1, End: 2, Text: "날씨가 좋네요."},
	}, "ko")
	if len(got) != 1 || got[0].Text != "오늘은 날씨가 좋네요." {
		t.Fatalf("한국어 병합 = %+v", got)
	}
}

func TestMergeStopsRunawayGrowth(t *testing.T) {
	// Without a ceiling, a punctuation-free track with no pauses would merge
	// into a single unusable blob.
	var cues []Cue
	for i := 0; i < 40; i++ {
		cues = append(cues, Cue{
			Start: float64(i) * 0.5,
			End:   float64(i)*0.5 + 0.5,
			Text:  "あいうえお",
		})
	}

	got := MergeCues(cues)
	if len(got) < 2 {
		t.Fatalf("문장 수 = %d — 상한이 동작하지 않음", len(got))
	}
	for i, s := range got {
		if n := len([]rune(s.Text)); n > maxMergedRunes+10 {
			t.Errorf("[%d] 길이 %d — 상한 %d 를 크게 넘음", i, n, maxMergedRunes)
		}
	}
}

func TestSelectFiltersUnpracticableLengths(t *testing.T) {
	got := Select([]Sentence{
		{Text: "うん。", Start: 0}, // 너무 짧다
		{Text: "これは練習할 만한 길이의 문장입니다。", Start: 10},    // 적당
		{Text: string(make([]rune, 100)), Start: 20}, // 너무 길다
	}, 10)

	if len(got) != 1 {
		t.Fatalf("선별 수 = %d, 기대 1: %v", len(got), texts(got))
	}
}

func TestSelectSpreadsAcrossTimeline(t *testing.T) {
	// The failure this guards against: ranking by score alone clusters the
	// whole set in whichever stretch happens to be dense, so the learner
	// "finishes" the video without ever reaching the end of it.
	var sentences []Sentence
	// 앞 10개는 학습 단어가 많고, 뒤 10개는 적다.
	for i := 0; i < 10; i++ {
		sentences = append(sentences, Sentence{
			Text: "これは前半の練習文です。", Start: float64(i), StudyCount: 5,
		})
	}
	for i := 0; i < 10; i++ {
		sentences = append(sentences, Sentence{
			Text: "これは後半の練習文です。", Start: float64(100 + i), StudyCount: 1,
		})
	}

	got := Select(sentences, 4)
	if len(got) == 0 {
		t.Fatal("선별 결과가 없음")
	}

	var late int
	for _, s := range got {
		if s.Start >= 100 {
			late++
		}
	}
	if late == 0 {
		t.Errorf("후반부에서 하나도 안 뽑힘 — 점수만 보고 앞쪽에 몰렸다: %+v", got)
	}
}

func TestSelectPrefersStudyHeavyWithinBucket(t *testing.T) {
	// 같은 시간대라면 학습 단어가 많은 쪽을 고른다.
	got := Select([]Sentence{
		{Text: "학습 단어가 없는 문장입니다。", Start: 0, StudyCount: 0},
		{Text: "학습 단어가 많은 문장입니다。", Start: 0.1, StudyCount: 4},
	}, 1)

	if len(got) != 1 {
		t.Fatalf("선별 수 = %d, 기대 1", len(got))
	}
	if got[0].StudyCount != 4 {
		t.Errorf("StudyCount = %d, 기대 4 — 학습 가치가 낮은 쪽을 골랐다", got[0].StudyCount)
	}
}

func TestSelectReturnsAllWhenFewerThanLimit(t *testing.T) {
	got := Select([]Sentence{
		{Text: "첫 번째 연습 문장입니다。", Start: 0},
		{Text: "두 번째 연습 문장입니다。", Start: 5},
	}, 20)

	if len(got) != 2 {
		t.Errorf("선별 수 = %d, 기대 2", len(got))
	}
}

func TestSelectIsOrderedByTime(t *testing.T) {
	got := Select([]Sentence{
		{Text: "세 번째 연습 문장입니다。", Start: 30},
		{Text: "첫 번째 연습 문장입니다。", Start: 0},
		{Text: "두 번째 연습 문장입니다。", Start: 15},
	}, 3)

	for i := 1; i < len(got); i++ {
		if got[i].Start < got[i-1].Start {
			t.Fatalf("시간순이 아님: %v", got)
		}
	}
}

func TestCountStudyTokens(t *testing.T) {
	n := CountStudyTokens([]model.Token{
		{Surface: "勉強", Highlight: true},
		{Surface: "を", Highlight: false},
		{Surface: "する", Highlight: true},
	})
	if n != 2 {
		t.Errorf("= %d, 기대 2", n)
	}
}

func TestSelectRemovesDuplicates(t *testing.T) {
	// 상투어나 맞장구는 실제 영상에서 반복된다. 20문장짜리 세트에 같은 줄이
	// 여러 번 들어가면 연습량만 낭비된다.
	var sentences []Sentence
	for i := 0; i < 10; i++ {
		sentences = append(sentences, Sentence{
			Text: "同じことを繰り返しています。", Start: float64(i * 10),
		})
	}
	sentences = append(sentences, Sentence{Text: "이건 다른 연습 문장입니다。", Start: 200})

	got := Select(sentences, 20)

	seen := map[string]int{}
	for _, s := range got {
		seen[s.Text]++
	}
	for text, n := range seen {
		if n > 1 {
			t.Errorf("%q 가 %d번 중복됨", text, n)
		}
	}
	if len(got) != 2 {
		t.Errorf("선별 수 = %d, 기대 2 (중복 제거 후): %v", len(got), texts(got))
	}
}
