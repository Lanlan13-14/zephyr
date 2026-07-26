package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Listen            string
	AdminToken        string
	DataDir           string
	PlatformHostURL   string
	PlatformHostToken string
	DefaultMaxSteps   int
	// Public base used when returning SSE URLs to Node (optional).
	PublicBaseURL string
}

func FromEnv() Config {
	cfg := Config{
		Listen:            env("ZEPHYR_AI_LISTEN", "127.0.0.1:8450"),
		AdminToken:        env("ZEPHYR_AI_ADMIN_TOKEN", ""),
		DataDir:           env("ZEPHYR_AI_DATA", "./data/zephyr-ai"),
		PlatformHostURL:   env("ZEPHYR_AI_PLATFORM_HOST_URL", "http://127.0.0.1:3080"),
		PlatformHostToken: env("ZEPHYR_AI_PLATFORM_HOST_TOKEN", ""),
		DefaultMaxSteps:   envInt("ZEPHYR_AI_MAX_STEPS", 32),
		PublicBaseURL:     env("ZEPHYR_AI_PUBLIC_BASE_URL", ""),
	}
	return cfg
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
