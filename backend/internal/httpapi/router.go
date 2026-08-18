// Package httpapi wires the HTTP surface.
package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/marineyang/langflix-jp/backend/internal/config"
	"github.com/marineyang/langflix-jp/backend/internal/dict"
	"github.com/marineyang/langflix-jp/backend/internal/nlp"
	"github.com/marineyang/langflix-jp/backend/internal/store"
	"github.com/marineyang/langflix-jp/backend/internal/translate"
)

type Server struct {
	cfg        config.Config
	translator *translate.Cached
	analyzer   nlp.Analyzer
	dict       *dict.Cached
	store      store.Store
}

func New(cfg config.Config, t *translate.Cached, a nlp.Analyzer, d *dict.Cached, s store.Store) *Server {
	return &Server{cfg: cfg, translator: t, analyzer: a, dict: d, store: s}
}

func (s *Server) Router() *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery(), gin.Logger(), s.cors())

	r.GET("/healthz", s.health)

	v1 := r.Group("/v1")
	{
		v1.POST("/translate", s.translate)
		v1.POST("/nlp/analyze", s.analyze)
		v1.POST("/dict/lookup", s.dictLookup)
		v1.POST("/shadowing/set", s.shadowingSet)
		v1.POST("/shadowing/attempts", s.createShadowingAttempt)
		v1.GET("/shadowing/reviews", s.listShadowingReviews)
		v1.POST("/shadowing/attempts/:id/review", s.completeShadowingReview)
		v1.POST("/expressions", s.createExpression)
		v1.GET("/expressions", s.listExpressions)
		v1.DELETE("/expressions/:id", s.deleteExpression)
	}

	return r
}

// cors permits the extension to call the API from the streaming site's origin.
//
// Requests originate from a content script running on youtube.com or
// netflix.com, so the Origin header is that site — not the extension ID. In
// dev the allowlist defaults to "*"; set ALLOWED_ORIGINS before deploying.
func (s *Server) cors() gin.HandlerFunc {
	allowAll := len(s.cfg.AllowedOrigins) == 1 && s.cfg.AllowedOrigins[0] == "*"
	allowed := make(map[string]bool, len(s.cfg.AllowedOrigins))
	for _, o := range s.cfg.AllowedOrigins {
		allowed[o] = true
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		switch {
		case allowAll:
			c.Header("Access-Control-Allow-Origin", "*")
		case origin != "" && allowed[origin]:
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
		}
		c.Header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, X-User-Id")

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// userID identifies the caller.
//
// Auth is not implemented yet — the architecture calls for Google OAuth, but
// requiring it now would block extension testing. Until then every request
// falls back to a single dev user, overridable with X-User-Id.
func userID(c *gin.Context) string {
	if id := c.GetHeader("X-User-Id"); id != "" {
		return id
	}
	return "dev-user"
}
