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

type Config struct {
	Port            string
	AllowedOrigins  []string
	AnthropicAPIKey string
	Model           string
	NLPServiceURL   string
	DataFile        string
	DictCacheFile   string
	HTTPTimeout     time.Duration
}

func Load() Config {
	return Config{
		Port:            env("PORT", "8090"),
		AllowedOrigins:  splitCSV(env("ALLOWED_ORIGINS", "*")),
		AnthropicAPIKey: env("ANTHROPIC_API_KEY", ""),
		Model:           env("ANTHROPIC_MODEL", "claude-opus-5"),
		NLPServiceURL:   env("NLP_SERVICE_URL", ""),
		DataFile:        env("DATA_FILE", ""),
		DictCacheFile:   env("DICT_CACHE_FILE", ""),
		HTTPTimeout:     60 * time.Second,
	}
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
