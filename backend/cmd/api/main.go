// Command api runs the langflix-jp backend.
//
// It boots with zero configuration: without ANTHROPIC_API_KEY or
// NLP_SERVICE_URL it serves every endpoint using stub providers, so the
// extension can be developed and tested before either is provisioned.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/marineyang/langflix-jp/backend/internal/config"
	"github.com/marineyang/langflix-jp/backend/internal/httpapi"
	"github.com/marineyang/langflix-jp/backend/internal/nlp"
	"github.com/marineyang/langflix-jp/backend/internal/store"
	"github.com/marineyang/langflix-jp/backend/internal/translate"
)

func main() {
	cfg := config.Load()

	var base translate.Translator
	if cfg.AnthropicAPIKey != "" {
		base = translate.NewClaude(cfg.AnthropicAPIKey, cfg.Model)
	} else {
		base = translate.Stub{}
		log.Println("ANTHROPIC_API_KEY not set — serving stub translations")
	}
	translator := translate.NewCached(base)

	var analyzer nlp.Analyzer
	if cfg.NLPServiceURL != "" {
		analyzer = nlp.NewRemote(cfg.NLPServiceURL, &http.Client{Timeout: cfg.HTTPTimeout})
	} else {
		analyzer = nlp.Stub{}
		log.Println("NLP_SERVICE_URL not set — serving character-class segmentation only")
	}

	var dataStore store.Store = store.NewMemory()
	if cfg.DataFile != "" {
		fileStore, err := store.NewFile(cfg.DataFile)
		if err != nil {
			log.Fatalf("open DATA_FILE: %v", err)
		}
		dataStore = fileStore
		log.Printf("persisting expressions and shadowing reviews to %s", cfg.DataFile)
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           httpapi.New(cfg, translator, analyzer, dataStore).Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("listening on :%s (translator=%s nlp=%s)", cfg.Port, translator.Name(), analyzer.Name())
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
