package config

import "testing"

// The point of "auto" is that one key is enough configuration. The point of the
// key check on an explicit choice is that a typo in LLM_PROVIDER must not
// silently downgrade a configured server to stubs.
func TestResolveProvider(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		want string
	}{
		{"no keys", Config{Provider: ProviderAuto}, ""},
		{"auto picks the key that exists", Config{Provider: ProviderAuto, OpenAIAPIKey: "k"}, ProviderOpenAI},
		{"explicit openai", Config{Provider: ProviderOpenAI, OpenAIAPIKey: "k", AnthropicAPIKey: "a"}, ProviderOpenAI},
		{"explicit anthropic", Config{Provider: ProviderAnthropic, OpenAIAPIKey: "k", AnthropicAPIKey: "a"}, ProviderAnthropic},
		{"explicit choice without its key falls back", Config{Provider: ProviderOpenAI, AnthropicAPIKey: "a"}, ProviderAnthropic},
		{"unknown provider name", Config{Provider: "gemini", OpenAIAPIKey: "k"}, ProviderOpenAI},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.ResolveProvider(); got != tc.want {
				t.Errorf("ResolveProvider() = %q, want %q", got, tc.want)
			}
		})
	}
}
