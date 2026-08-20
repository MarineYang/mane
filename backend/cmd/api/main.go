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
	"github.com/marineyang/langflix-jp/backend/internal/dict"
	"github.com/marineyang/langflix-jp/backend/internal/httpapi"
	"github.com/marineyang/langflix-jp/backend/internal/nlp"
	"github.com/marineyang/langflix-jp/backend/internal/store"
	"github.com/marineyang/langflix-jp/backend/internal/translate"
)

func main() {
	cfg := config.Load()

	// Translation and the dictionary always run on the same provider — a learner
	// reading a Korean line and then tapping a word in it should not get two
	// different models' idea of what the sentence means.
	provider := cfg.ResolveProvider()

	var base translate.Translator
	switch provider {
	case config.ProviderAnthropic:
		base = translate.NewClaude(cfg.AnthropicAPIKey, cfg.Model)
	case config.ProviderOpenAI:
		base = translate.NewOpenAI(cfg.OpenAIAPIKey, cfg.OpenAIModel, cfg.OpenAIBaseURL, cfg.HTTPTimeout)
	default:
		base = translate.Stub{}
		log.Println("no ANTHROPIC_API_KEY or OPENAI_API_KEY — serving stub translations (보조 자막 줄이 빈 채로 나온다)")
	}
	translator := translate.NewCached(base)

	// The dictionary cache is the dictionary: entries cost an API call to
	// produce once and are free forever after, so persisting it is what keeps
	// word lookups cheap across restarts.
	var dictBase dict.Provider
	switch provider {
	case config.ProviderAnthropic:
		dictBase = dict.NewClaude(cfg.AnthropicAPIKey, cfg.Model)
	case config.ProviderOpenAI:
		dictBase = dict.NewOpenAI(cfg.OpenAIAPIKey, cfg.OpenAIModel, cfg.OpenAIBaseURL, cfg.HTTPTimeout)
	default:
		dictBase = dict.Stub{}
		log.Println("no ANTHROPIC_API_KEY or OPENAI_API_KEY — word meanings unavailable (dict=stub)")
	}
	dictionary := dict.NewCached(dictBase)
	if cfg.DictCacheFile != "" {
		var err error
		dictionary, err = dictionary.WithFile(cfg.DictCacheFile)
		if err != nil {
			log.Fatalf("open DICT_CACHE_FILE: %v", err)
		}
		log.Printf("dictionary cache at %s (%d entries)", cfg.DictCacheFile, dictionary.Len())
	}

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
		Handler:           httpapi.New(cfg, translator, analyzer, dictionary, dataStore).Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("listening on :%s (translator=%s nlp=%s dict=%s)",
			cfg.Port, translator.Name(), analyzer.Name(), dictionary.Name())
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
