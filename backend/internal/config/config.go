// Package config loads runtime configuration from the environment.
//
// Every external dependency is optional: with no environment set at all the
// server still boots and serves every endpoint using in-memory storage and
// stub providers. That is deliberate — the extension must be testable before
// anyone has provisioned an API key or the NLP service.
package config

import (
	"os"
	"strings"
	"time"
)

// Provider names the LLM behind translation and the dictionary.
const (
	ProviderAuto      = "auto"
	ProviderAnthropic = "anthropic"
	ProviderOpenAI    = "openai"
)

type Config struct {
	Port            string
	AllowedOrigins  []string
	Provider        string
	AnthropicAPIKey string
	Model           string
	OpenAIAPIKey    string
	OpenAIModel     string
	OpenAIBaseURL   string
	NLPServiceURL   string
	DataFile        string
	DictCacheFile   string
	HTTPTimeout     time.Duration
}

func Load() Config {
	return Config{
		Port:            env("PORT", "8090"),
		AllowedOrigins:  splitCSV(env("ALLOWED_ORIGINS", "*")),
		Provider:        strings.ToLower(env("LLM_PROVIDER", ProviderAuto)),
		AnthropicAPIKey: env("ANTHROPIC_API_KEY", ""),
		Model:           env("ANTHROPIC_MODEL", "claude-opus-5"),
		OpenAIAPIKey:    env("OPENAI_API_KEY", ""),
		OpenAIModel:     env("OPENAI_MODEL", "gpt-4.1"),
		OpenAIBaseURL:   env("OPENAI_BASE_URL", ""),
		NLPServiceURL:   env("NLP_SERVICE_URL", ""),
		DataFile:        env("DATA_FILE", ""),
		DictCacheFile:   env("DICT_CACHE_FILE", ""),
		HTTPTimeout:     60 * time.Second,
	}
}

// ResolveProvider picks the LLM to use.
//
// "auto" exists so the common case needs no configuration: set one key and the
// server uses it. An explicit LLM_PROVIDER wins, but only if that provider
// actually has a key — otherwise the caller would get a silent stub while
// believing they configured a real provider.
func (c Config) ResolveProvider() string {
	switch c.Provider {
	case ProviderOpenAI:
		if c.OpenAIAPIKey != "" {
			return ProviderOpenAI
		}
	case ProviderAnthropic:
		if c.AnthropicAPIKey != "" {
			return ProviderAnthropic
		}
	}
	// auto, or an explicit choice whose key is missing: take whichever key exists.
	if c.AnthropicAPIKey != "" {
		return ProviderAnthropic
	}
	if c.OpenAIAPIKey != "" {
		return ProviderOpenAI
	}
	return ""
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
