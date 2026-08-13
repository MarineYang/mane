// Package shadowing turns a subtitle track into a practice set.
//
// Two steps, and the first one matters more than it looks:
//
//  1. Merge cues into sentences. Subtitle cues are not sentences — they are
//     3-to-5-second display chunks that split mid-clause, and auto-generated
//     tracks carry no punctuation at all. Shadowing a half-sentence teaches
//     nothing, so the cues have to be reassembled first.
//  2. Select the handful worth practising. A 10-minute video yields ~90
//     sentences; nobody finishes that. The set has to be small enough to
//     complete in one sitting, which is what makes "I mastered this video"
//     a reachable claim.
package shadowing

import (
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

// Cue is one subtitle line as the player delivers it.
type Cue struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

// Sentence is a merged, practice-sized unit.
type Sentence struct {
	Text       string        `json:"text"`
	Start      float64       `json:"start"`
	End        float64       `json:"end"`
	Tokens     []model.Token `json:"tokens,omitempty"`
	StudyCount int           `json:"study_count"`
}

// Merge tuning. These are the numbers most likely to need adjusting once real
// selections are eyeballed, so they live together rather than inline.
const (
	// Gap between cues that implies a new utterance even without punctuation.
	// Auto-generated tracks have no 。 at all, so timing is the only signal.
	maxGapSeconds = 0.8
	// Ceilings that stop a punctuation-free track merging into one huge blob.
	maxMergedRunes   = 60
	maxMergedSeconds = 12.0
)

// sentenceEnders are the characters that reliably close a Japanese sentence.
// Closing quotes count because dialogue often ends 「…」 with no other mark.
const sentenceEnders = "。．.！!？?」』"

func endsSentence(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	last, _ := utf8.DecodeLastRuneInString(trimmed)
	return strings.ContainsRune(sentenceEnders, last)
}

// MergeCues reassembles cues into sentences.
//
// A run of cues is flushed when the text closes a sentence, when the next cue
// starts after a noticeable pause, or when the run grows past the ceilings
// above. Timing is preserved: a merged sentence spans from the first cue's
// start to the last cue's end, so it can still be replayed in place.
func MergeCues(cues []Cue) []Sentence {
	return MergeCuesForLanguage(cues, "ja")
}

// MergeCuesForLanguage preserves each language's spacing convention. Japanese
// subtitles should not gain artificial spaces; Korean cues need a separator or
// independently trimmed caption chunks collapse into one word.
func MergeCuesForLanguage(cues []Cue, language string) []Sentence {
	var out []Sentence
	var buf []string
	var start, end float64
	var runes int

	flush := func() {
		if len(buf) == 0 {
			return
		}
		separator := ""
		if language == "ko" {
			separator = " "
		}
		text := strings.TrimSpace(strings.Join(buf, separator))
		if text != "" {
			out = append(out, Sentence{Text: text, Start: start, End: end})
		}
		buf = nil
		runes = 0
	}

	for i, cue := range cues {
		text := strings.TrimSpace(cue.Text)
		if text == "" {
			continue
		}

		if len(buf) == 0 {
			start = cue.Start
		}
		buf = append(buf, text)
		end = cue.End
		runes += utf8.RuneCountInString(text)

		gapAhead := i+1 >= len(cues) || cues[i+1].Start-cue.End > maxGapSeconds
		tooLong := runes >= maxMergedRunes || end-start >= maxMergedSeconds

		if endsSentence(text) || gapAhead || tooLong {
			flush()
		}
	}
	flush()

	return out
}

// Selection tuning.
const (
	// Below this a sentence is a fragment ("うん", "そうですね") with nothing to
	// practise; above it, one breath isn't enough to shadow it.
	minPracticeRunes = 6
	maxPracticeRunes = 40
)

// Select picks the sentences worth practising.
//
// Candidates are filtered by length, then spread across the video: the
// timeline is cut into `limit` buckets and the best sentence in each is taken.
// Ranking purely by score would cluster the whole set wherever the dense
// speech happens to be — usually the first few minutes — and a set you can
// finish without reaching the end of the video defeats the point.
//
// Within a bucket, the sentence carrying the most study-target words wins;
// mid-length sentences break the tie, since very short and very long ones are
// both awkward to shadow.
func Select(sentences []Sentence, limit int) []Sentence {
	if limit <= 0 {
		return nil
	}

	candidates := make([]Sentence, 0, len(sentences))
	for _, s := range sentences {
		n := utf8.RuneCountInString(s.Text)
		if n >= minPracticeRunes && n <= maxPracticeRunes {
			candidates = append(candidates, s)
		}
	}
	if len(candidates) == 0 {
		return nil
	}

	// 버킷 계산도 결과 순서도 시간순을 전제한다. 호출자가 정렬해서 준다는
	// 가정에 기대지 않고 여기서 보장한다.
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Start < candidates[j].Start })

	candidates = dedupe(candidates)

	if len(candidates) <= limit {
		return candidates
	}

	first := candidates[0].Start
	last := candidates[len(candidates)-1].Start
	span := last - first
	if span <= 0 {
		return candidates[:limit]
	}

	best := make(map[int]Sentence)
	for _, s := range candidates {
		bucket := int(float64(limit) * (s.Start - first) / span)
		if bucket >= limit {
			bucket = limit - 1
		}
		if cur, ok := best[bucket]; !ok || better(s, cur) {
			best[bucket] = s
		}
	}

	picked := make([]Sentence, 0, len(best))
	for _, s := range best {
		picked = append(picked, s)
	}
	sort.Slice(picked, func(i, j int) bool { return picked[i].Start < picked[j].Start })
	return picked
}

// dedupe drops repeated sentences, keeping the best occurrence of each.
//
// Real speech repeats: catchphrases, 相槌, a host restating the topic. Without
// this, a 20-sentence set can spend a quarter of its slots on the same line,
// which is wasted practice and makes the set feel padded.
func dedupe(sentences []Sentence) []Sentence {
	bestOf := make(map[string]Sentence, len(sentences))
	for _, s := range sentences {
		key := strings.TrimSpace(s.Text)
		if cur, ok := bestOf[key]; !ok || better(s, cur) {
			bestOf[key] = s
		}
	}

	out := make([]Sentence, 0, len(bestOf))
	for _, s := range bestOf {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}

// better reports whether a should be preferred over b within a bucket.
func better(a, b Sentence) bool {
	if a.StudyCount != b.StudyCount {
		return a.StudyCount > b.StudyCount
	}
	return lengthFit(a.Text) > lengthFit(b.Text)
}

// lengthFit scores how comfortable a sentence is to shadow — peaking in the
// middle of the acceptable range and falling off toward both ends.
func lengthFit(text string) float64 {
	n := float64(utf8.RuneCountInString(text))
	ideal := float64(minPracticeRunes+maxPracticeRunes) / 2
	half := float64(maxPracticeRunes-minPracticeRunes) / 2
	d := n - ideal
	if d < 0 {
		d = -d
	}
	return 1 - d/half
}

// CountStudyTokens counts the tokens the analyzer flagged as worth learning.
func CountStudyTokens(tokens []model.Token) int {
	n := 0
	for _, t := range tokens {
		if t.Highlight {
			n++
		}
	}
	return n
}
