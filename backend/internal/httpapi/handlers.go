package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/marineyang/langflix-jp/backend/internal/model"
	"github.com/marineyang/langflix-jp/backend/internal/shadowing"
	"github.com/marineyang/langflix-jp/backend/internal/store"
	"github.com/marineyang/langflix-jp/backend/internal/translate"
)

const maxBatch = 500

func fail(c *gin.Context, status int, msg string) {
	c.JSON(status, gin.H{"error": msg})
}

func (s *Server) health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":     "ok",
		"translator": s.translator.Name(),
		"nlp":        s.analyzer.Name(),
	})
}

// --- translate ---

type translateRequest struct {
	SourceLang string   `json:"source_lang"`
	TargetLang string   `json:"target_lang"`
	Texts      []string `json:"texts"`
}

func (s *Server) translate(c *gin.Context) {
	var req translateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if len(req.Texts) == 0 {
		c.JSON(http.StatusOK, gin.H{"translations": []translate.Result{}})
		return
	}
	if len(req.Texts) > maxBatch {
		fail(c, http.StatusBadRequest, "too many texts; max "+strconv.Itoa(maxBatch)+" per request")
		return
	}
	if req.SourceLang == "" {
		req.SourceLang = "ja"
	}
	if req.TargetLang == "" {
		req.TargetLang = "ko"
	}
	if (req.SourceLang != "ja" && req.SourceLang != "ko") ||
		(req.TargetLang != "ja" && req.TargetLang != "ko") ||
		req.SourceLang == req.TargetLang {
		fail(c, http.StatusBadRequest, "source_lang and target_lang must be different ja/ko values")
		return
	}

	results, err := s.translator.TranslateWithMeta(c.Request.Context(), req.SourceLang, req.TargetLang, req.Texts)
	if err != nil {
		fail(c, http.StatusBadGateway, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"translations": results})
}

// --- nlp ---

type analyzeRequest struct {
	Texts []string `json:"texts"`
	Level string   `json:"level"`
}

func (s *Server) analyze(c *gin.Context) {
	var req analyzeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if len(req.Texts) == 0 {
		c.JSON(http.StatusOK, gin.H{"results": []model.Analysis{}})
		return
	}
	if len(req.Texts) > maxBatch {
		fail(c, http.StatusBadRequest, "too many texts; max "+strconv.Itoa(maxBatch)+" per request")
		return
	}

	results, err := s.analyzer.Analyze(c.Request.Context(), req.Texts, req.Level)
	if err != nil {
		fail(c, http.StatusBadGateway, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"results": results})
}

// --- shadowing ---

type shadowingSetRequest struct {
	Cues       []shadowing.Cue `json:"cues"`
	Level      string          `json:"level"`
	SourceLang string          `json:"source_lang"`
	Limit      int             `json:"limit"`
}

const (
	defaultSetSize = 20
	maxSetSize     = 30
)

// shadowingSet turns a subtitle track into a practice set.
//
// Analysis failure is not fatal: without tokens every sentence scores zero for
// study value and selection falls back to length and spread. A set chosen on
// weaker signals still beats no set at all.
func (s *Server) shadowingSet(c *gin.Context) {
	var req shadowingSetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if len(req.Cues) == 0 {
		fail(c, http.StatusBadRequest, "cues is required")
		return
	}

	limit := req.Limit
	if limit <= 0 {
		limit = defaultSetSize
	}
	if limit > maxSetSize {
		limit = maxSetSize
	}

	if req.SourceLang == "" {
		req.SourceLang = "ja"
	}
	if req.SourceLang != "ja" && req.SourceLang != "ko" {
		fail(c, http.StatusBadRequest, "source_lang must be ja or ko")
		return
	}

	sentences := shadowing.MergeCuesForLanguage(req.Cues, req.SourceLang)

	texts := make([]string, len(sentences))
	for i, sent := range sentences {
		texts[i] = sent.Text
	}

	analyzed := req.SourceLang == "ja"
	if analyzed {
		for start := 0; start < len(texts); start += maxBatch {
			end := start + maxBatch
			if end > len(texts) {
				end = len(texts)
			}
			results, err := s.analyzer.Analyze(c.Request.Context(), texts[start:end], req.Level)
			if err != nil {
				analyzed = false
				break
			}
			for i, r := range results {
				if start+i >= len(sentences) {
					break
				}
				sentences[start+i].Tokens = r.Tokens
				sentences[start+i].StudyCount = shadowing.CountStudyTokens(r.Tokens)
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"sentences":    shadowing.Select(sentences, limit),
		"merged_total": len(sentences),
		"analyzed":     analyzed,
	})
}

type createShadowingAttemptRequest struct {
	SourceLang  string                 `json:"source_lang"`
	TargetLang  string                 `json:"target_lang"`
	Text        string                 `json:"text"`
	Translation string                 `json:"translation"`
	ReviewOf    string                 `json:"review_of"`
	SelfRating  string                 `json:"self_rating"`
	Start       float64                `json:"start"`
	End         float64                `json:"end"`
	Source      model.Source           `json:"source"`
	Metrics     model.ShadowingMetrics `json:"metrics"`
}

func (s *Server) createShadowingAttempt(c *gin.Context) {
	var req createShadowingAttemptRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "invalid JSON body")
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" {
		fail(c, http.StatusBadRequest, "text is required")
		return
	}
	if utf8.RuneCountInString(req.Text) > 500 ||
		utf8.RuneCountInString(req.Translation) > 2000 ||
		utf8.RuneCountInString(req.Metrics.RecognizedText) > 1000 {
		fail(c, http.StatusBadRequest, "shadowing text is too long")
		return
	}
	if req.SourceLang == "" {
		req.SourceLang = "ja"
	}
	if req.TargetLang == "" {
		req.TargetLang = "ko"
	}
	if (req.SourceLang != "ja" && req.SourceLang != "ko") ||
		(req.TargetLang != "ja" && req.TargetLang != "ko") ||
		req.SourceLang == req.TargetLang {
		fail(c, http.StatusBadRequest, "source_lang and target_lang must be different ja/ko values")
		return
	}
	if req.End <= req.Start {
		fail(c, http.StatusBadRequest, "end must be greater than start")
		return
	}
	if req.Metrics.ReferenceDuration <= 0 {
		req.Metrics.ReferenceDuration = req.End - req.Start
	}
	score, provisional, breakdown, feedback, hints, mode := 0, true, model.ScoreBreakdown{}, []string{}, []string{}, "self_assessment"
	if req.SelfRating != "" {
		switch req.SelfRating {
		case "hard":
			score = 45
			feedback = append(feedback, "내일 다시 연습하도록 예약했습니다.")
		case "good":
			score = 75
			feedback = append(feedback, "문장을 익히고 있습니다. 며칠 뒤 자막 없이 다시 말해보세요.")
		case "easy":
			score = 95
			feedback = append(feedback, "자연스럽게 말한 문장으로 기록했습니다.")
		default:
			fail(c, http.StatusBadRequest, "self_rating must be hard, good, or easy")
			return
		}
		_, _, _, _, hints = shadowing.Score(req.Text, req.SourceLang, model.ShadowingMetrics{})
	} else {
		mode = "microphone"
		if req.Metrics.RecordingDuration <= 0 {
			fail(c, http.StatusBadRequest, "self_rating or metrics.recording_duration is required")
			return
		}
		if req.Metrics.RecordingDuration > 120 ||
			req.Metrics.OnsetSec < 0 ||
			req.Metrics.SpeechRatio < 0 ||
			req.Metrics.SpeechRatio > 1 {
			fail(c, http.StatusBadRequest, "invalid shadowing metrics")
			return
		}
		score, provisional, breakdown, feedback, hints = shadowing.Score(req.Text, req.SourceLang, req.Metrics)
	}
	now := time.Now().UTC()
	dueAfter := 24 * time.Hour
	if req.SelfRating == "good" {
		dueAfter = 72 * time.Hour
	} else if req.SelfRating == "easy" {
		dueAfter = 7 * 24 * time.Hour
	} else if score >= 85 {
		dueAfter = 48 * time.Hour
	}
	attempt := &model.ShadowingAttempt{
		UserID:        userID(c),
		SourceLang:    req.SourceLang,
		TargetLang:    req.TargetLang,
		Text:          req.Text,
		Translation:   req.Translation,
		Start:         req.Start,
		End:           req.End,
		Source:        req.Source,
		Metrics:       req.Metrics,
		Score:         score,
		Provisional:   provisional,
		Breakdown:     breakdown,
		Feedback:      feedback,
		PracticeHints: hints,
		ReviewOf:      req.ReviewOf,
		Mode:          mode,
		SelfRating:    req.SelfRating,
	}
	if req.ReviewOf == "" {
		attempt.DueAt = now.Add(dueAfter)
	}
	if err := s.store.CreateAttempt(c.Request.Context(), attempt); err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusCreated, attempt)
}

func (s *Server) listShadowingReviews(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	dueBefore := time.Now().UTC()
	if raw := c.Query("due_before"); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			fail(c, http.StatusBadRequest, "due_before must be RFC3339")
			return
		}
		dueBefore = parsed
	}
	items, err := s.store.ListDueAttempts(c.Request.Context(), userID(c), dueBefore, limit)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"reviews": items, "total": len(items)})
}

type completeReviewRequest struct {
	Score int `json:"score"`
}

func (s *Server) completeShadowingReview(c *gin.Context) {
	var req completeReviewRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Score < 0 || req.Score > 100 {
		fail(c, http.StatusBadRequest, "score must be between 0 and 100")
		return
	}

	// A tiny, predictable SRS: struggling sentences return tomorrow; fluent
	// ones expand with each successful review.
	days := 1
	if req.Score >= 70 {
		days = 3
	}
	if req.Score >= 85 {
		days = 7
	}
	updated, err := s.store.CompleteReview(
		c.Request.Context(),
		userID(c),
		c.Param("id"),
		req.Score,
		time.Now().UTC().Add(time.Duration(days)*24*time.Hour),
	)
	if errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusNotFound, "shadowing attempt not found")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, updated)
}

// --- expressions ---

type createExpressionRequest struct {
	Surface string       `json:"surface"`
	Reading string       `json:"reading"`
	Gloss   string       `json:"gloss"`
	JLPT    string       `json:"jlpt"`
	Context string       `json:"context"`
	Source  model.Source `json:"source"`
}

func (s *Server) createExpression(c *gin.Context) {
	var req createExpressionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Surface == "" {
		fail(c, http.StatusBadRequest, "surface is required")
		return
	}

	e := &model.Expression{
		UserID:  userID(c),
		Surface: req.Surface,
		Reading: req.Reading,
		Gloss:   req.Gloss,
		JLPT:    req.JLPT,
		Context: req.Context,
		Source:  req.Source,
	}
	if err := s.store.Create(c.Request.Context(), e); err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusCreated, e)
}

func (s *Server) listExpressions(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	if limit <= 0 || limit > maxBatch {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}

	items, total, err := s.store.List(c.Request.Context(), userID(c), limit, offset)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"expressions": items, "total": total})
}

func (s *Server) deleteExpression(c *gin.Context) {
	err := s.store.Delete(c.Request.Context(), userID(c), c.Param("id"))
	if errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusNotFound, "expression not found")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.Status(http.StatusNoContent)
}
