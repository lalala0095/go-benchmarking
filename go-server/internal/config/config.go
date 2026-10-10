// Package config reads the server configuration from environment variables
// (docs/02-TECHNICAL-REQUIREMENTS.md §4.3).
package config

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Config is the full server configuration.
type Config struct {
	Port string

	GoogleAPIKey     string
	GeminiModel      string
	GeminiEmbedModel string
	// GeminiEmbedTaskType: "" (default, no task type), "retrieval", or a literal.
	GeminiEmbedTaskType string

	DatabaseURL string
	DBPoolMax   int
	// SessionDBPoolMax caps the GORM (database/sql) pool used only by ADK's
	// session service.
	SessionDBPoolMax int

	MockFirstTokenDelay time.Duration
	MockTokenDelay      time.Duration
	MockTokens          int
	MockEmbedDelay      time.Duration
	EmbedBatchSize      int

	CorpusDir    string
	ContractsDir string
	SQLDir       string
}

// GeminiConfigured reports whether a Gemini API key is present.
func (c *Config) GeminiConfigured() bool { return c.GoogleAPIKey != "" }

// InstructionPath is the agent instruction file inside the contracts dir.
func (c *Config) InstructionPath() string {
	return filepath.Join(c.ContractsDir, "agent-instruction.txt")
}

// RAGQueriesPath is the preset query fixture used by ?preset=random.
func (c *Config) RAGQueriesPath() string {
	return filepath.Join(c.ContractsDir, "fixtures", "rag-queries.json")
}

// Load reads the configuration from the environment, applying defaults.
func Load() *Config {
	contracts := str("CONTRACTS_DIR", "/contracts")
	return &Config{
		Port:                str("PORT", "8080"),
		GoogleAPIKey:        os.Getenv("GOOGLE_API_KEY"),
		GeminiModel:         str("GEMINI_MODEL", "gemini-3.5-flash-lite"),
		GeminiEmbedModel:    str("GEMINI_EMBED_MODEL", "gemini-embedding-2"),
		GeminiEmbedTaskType: os.Getenv("GEMINI_EMBED_TASK_TYPE"),
		DatabaseURL:         str("DATABASE_URL", "postgres://bench:bench@postgres:5432/go_app?sslmode=disable"),
		DBPoolMax:           intv("DB_POOL_MAX", 10, 1),
		SessionDBPoolMax:    intv("SESSION_DB_POOL_MAX", 15, 1),
		MockFirstTokenDelay: ms("MOCK_FIRST_TOKEN_DELAY_MS", 250),
		MockTokenDelay:      ms("MOCK_TOKEN_DELAY_MS", 15),
		MockTokens:          intv("MOCK_TOKENS", 60, 0),
		MockEmbedDelay:      ms("MOCK_EMBED_DELAY_MS", 40),
		EmbedBatchSize:      intv("EMBED_BATCH_SIZE", 100, 1),
		CorpusDir:           str("CORPUS_DIR", "/corpus"),
		ContractsDir:        contracts,
		SQLDir:              str("SQL_DIR", filepath.Join(contracts, "sql")),
	}
}

func str(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func intv(key string, def, min int) int {
	v, err := strconv.Atoi(os.Getenv(key))
	if err != nil || v < min {
		return def
	}
	return v
}

func ms(key string, def int) time.Duration {
	return time.Duration(intv(key, def, 0)) * time.Millisecond
}
