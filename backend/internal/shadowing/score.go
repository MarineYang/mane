package shadowing

import (
	"math"
	"regexp"
	"strings"
	"unicode"

	"github.com/marineyang/langflix-jp/backend/internal/model"
)

var japaneseLongVowel = regexp.MustCompile(`[おこそとのほもよろごぞどぼぽ]う|[えけせてねへめれげぜでべぺ]い|おお`)

// Score evaluates signals available in the browser. It deliberately calls the
// result provisional when ASR text is absent: rhythm is useful feedback, but it
// is not evidence of phoneme-level pronunciation quality.
func Score(text, sourceLang string, m model.ShadowingMetrics) (int, bool, model.ScoreBreakdown, []string, []string) {
	timing := durationScore(m.ReferenceDuration, m.RecordingDuration)
	delivery := deliveryScore(m.OnsetSec, m.SpeechRatio)
	breakdown := model.ScoreBreakdown{Timing: timing, Delivery: delivery}
	provisional := strings.TrimSpace(m.RecognizedText) == ""

	total := int(math.Round(float64(timing)*0.55 + float64(delivery)*0.45))
	if !provisional {
		match := textSimilarity(text, m.RecognizedText)
		breakdown.TextMatch = &match
		total = int(math.Round(float64(match)*0.55 + float64(timing)*0.25 + float64(delivery)*0.20))
	}
	total = clamp(total, 0, 100)

	feedback := make([]string, 0, 3)
	if provisional {
		feedback = append(feedback, "브라우저 음성 인식을 사용할 수 없어 리듬 중심의 임시 점수입니다.")
	} else if *breakdown.TextMatch < 75 {
		feedback = append(feedback, "인식되지 않은 부분이 있습니다. 원음을 짧은 덩어리로 나눠 다시 말해보세요.")
	}

	ratio := safeRatio(m.RecordingDuration, m.ReferenceDuration)
	switch {
	case ratio > 1.25:
		feedback = append(feedback, "원어민보다 말이 깁니다. 문장 사이의 불필요한 멈춤을 줄여보세요.")
	case ratio > 0 && ratio < 0.75:
		feedback = append(feedback, "원어민보다 말이 짧습니다. 빠뜨린 음절과 문장 끝을 확인하세요.")
	default:
		feedback = append(feedback, "원음과 발화 길이가 비슷합니다.")
	}
	if m.OnsetSec > 0.65 {
		feedback = append(feedback, "녹음 시작 뒤 첫 발화가 늦습니다. 준비한 뒤 한 호흡으로 시작해보세요.")
	}
	if m.SpeechRatio > 0 && m.SpeechRatio < 0.45 {
		feedback = append(feedback, "무음 구간이 많습니다. 먼저 에코잉으로 익힌 뒤 다시 녹음하세요.")
	}

	return total, provisional, breakdown, feedback, practiceHints(text, sourceLang)
}

func durationScore(reference, recording float64) int {
	if reference <= 0 || recording <= 0 {
		return 0
	}
	diff := math.Abs(recording-reference) / reference
	return clamp(int(math.Round(100-diff*100)), 0, 100)
}

func deliveryScore(onset, speechRatio float64) int {
	onsetScore := 100.0
	if onset > 0.2 {
		onsetScore = math.Max(0, 100-(onset-0.2)*100)
	}
	ratioScore := 100.0
	if speechRatio <= 0 {
		ratioScore = 0
	} else if speechRatio < 0.55 {
		ratioScore = speechRatio / 0.55 * 100
	} else if speechRatio > 0.95 {
		ratioScore = math.Max(0, 100-(speechRatio-0.95)*200)
	}
	return clamp(int(math.Round(onsetScore*0.45+ratioScore*0.55)), 0, 100)
}

func textSimilarity(want, got string) int {
	a := []rune(normalizeSpeech(want))
	b := []rune(normalizeSpeech(got))
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	d := levenshtein(a, b)
	denom := len(a)
	if len(b) > denom {
		denom = len(b)
	}
	return clamp(int(math.Round((1-float64(d)/float64(denom))*100)), 0, 100)
}

func normalizeSpeech(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, s)
}

func levenshtein(a, b []rune) int {
	prev := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i, ar := range a {
		cur := make([]int, len(b)+1)
		cur[0] = i + 1
		for j, br := range b {
			cost := 0
			if ar != br {
				cost = 1
			}
			cur[j+1] = min3(cur[j]+1, prev[j+1]+1, prev[j]+cost)
		}
		prev = cur
	}
	return prev[len(b)]
}

func practiceHints(text, sourceLang string) []string {
	var hints []string
	if sourceLang == "ja" {
		if strings.Contains(text, "っ") || strings.Contains(text, "ッ") {
			hints = append(hints, "촉음 っ은 다음 자음 앞에서 한 모라만큼 멈춥니다.")
		}
		if strings.Contains(text, "ー") || japaneseLongVowel.MatchString(text) {
			hints = append(hints, "장음 후보가 있습니다. 글자 수가 아니라 모라 박자로 따라 해보세요.")
		}
		if strings.Contains(text, "ん") || strings.Contains(text, "ン") {
			hints = append(hints, "ん은 뒤 자음에 따라 입 모양이 달라집니다. 원음의 연결을 확인하세요.")
		}
	} else if sourceLang == "ko" {
		hints = append(hints, koreanPracticeHints(text)...)
	}
	return hints
}

func koreanPracticeHints(text string) []string {
	runes := []rune(text)
	seen := make(map[string]bool)
	var hints []string
	add := func(hint string) {
		if !seen[hint] {
			seen[hint] = true
			hints = append(hints, hint)
		}
	}

	for i, r := range runes {
		_, vowel, tail, ok := decomposeHangul(r)
		if !ok {
			continue
		}
		// ㅓ/ㅗ, ㅡ/ㅜ는 일본어 화자가 자주 한 범주로 듣기 쉬운 대조다.
		if vowel == 4 || vowel == 8 || vowel == 13 || vowel == 18 {
			add("ㅓ·ㅗ 또는 ㅡ·ㅜ가 포함되어 있습니다. 입술 모양을 원음과 비교하세요.")
		}
		if tail == 0 || i+1 >= len(runes) {
			continue
		}
		nextIndex := i + 1
		for nextIndex < len(runes) && unicode.IsSpace(runes[nextIndex]) {
			nextIndex++
		}
		if nextIndex >= len(runes) {
			continue
		}
		nextOnset, _, _, nextOK := decomposeHangul(runes[nextIndex])
		if !nextOK {
			continue
		}
		switch {
		case nextOnset == 11 && tail != 21:
			add("받침 뒤에 모음이 이어지는 구간이 있습니다. 음절을 끊지 말고 연음을 확인하세요.")
		case tail == 27 && (nextOnset == 0 || nextOnset == 3 || nextOnset == 12):
			add("ㅎ 뒤 자음이 축약되거나 거센소리로 이어질 수 있습니다. 원음의 연결을 확인하세요.")
		case (nextOnset == 2 || nextOnset == 6) && isKoreanObstruentTail(tail):
			add("받침 뒤 ㄴ·ㅁ에서 비음화될 수 있습니다. 표기보다 실제 소리를 따라 하세요.")
		case isKoreanObstruentTail(tail) &&
			(nextOnset == 0 || nextOnset == 3 || nextOnset == 9 || nextOnset == 12):
			add("받침 뒤 자음이 된소리로 들릴 수 있습니다. 자음의 긴장도를 원음과 비교하세요.")
		}
	}
	if len(hints) == 0 {
		hints = append(hints, "받침과 음절 사이의 연결을 원음과 비교해보세요.")
	}
	return hints
}

func decomposeHangul(r rune) (onset, vowel, tail int, ok bool) {
	const (
		hangulBase = 0xAC00
		hangulLast = 0xD7A3
		vowels     = 21
		tails      = 28
	)
	if r < hangulBase || r > hangulLast {
		return 0, 0, 0, false
	}
	index := int(r - hangulBase)
	return index / (vowels * tails), (index % (vowels * tails)) / tails, index % tails, true
}

func isKoreanObstruentTail(tail int) bool {
	// 종성 인덱스 중 대표음이 ㄱ·ㄷ·ㅂ으로 중화되는 계열.
	switch tail {
	case 1, 2, 3, 7, 9, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27:
		return true
	default:
		return false
	}
}

func safeRatio(a, b float64) float64 {
	if b <= 0 {
		return 0
	}
	return a / b
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func min3(a, b, c int) int {
	if a < b && a < c {
		return a
	}
	if b < c {
		return b
	}
	return c
}
