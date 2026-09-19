package cell

// Unified environment variables (§3.3).
// Discipline: adding/modifying any default env requires a same-PR update
// across all six platforms; CI contract rejects otherwise.

// DefaultEnv returns the unified guest environment variables.
// These are byte-identical across all six platforms.
func DefaultEnv(sessionID, engineName, cellVersion string) map[string]string {
	return map[string]string{
		"PATH":                          "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME":                          "/root",
		"TERM":                          "xterm-256color",
		"CHARSET":                       "UTF-8",
		"LANG":                          "C.UTF-8",
		"LC_ALL":                        "C.UTF-8",
		"TZ":                            "UTC",
		"NO_COLOR":                      "1",
		"PYTHONDONTWRITEBYTECODE":       "1",
		"PIP_DISABLE_PIP_VERSION_CHECK": "1",
		"npm_config_update_notifier":    "false",
		"GOMAXPROCS":                    "2",
		"ZEPHYR_CELL":                   "1",
		"ZEPHYR_CELL_VERSION":           cellVersion,
		"ZEPHYR_SESSION_ID":             sessionID,
		"ZEPHYR_ENGINE":                 engineName,
		"BROWSER":                       "/usr/local/bin/zc-open",
		"ENV":                           "/etc/profile",
	}
}

// EnvKeys returns the sorted list of default environment variable names.
// Used by audit to record key names without values.
func EnvKeys() []string {
	return []string{
		"BROWSER",
		"CHARSET",
		"ENV",
		"GOMAXPROCS",
		"HOME",
		"LANG",
		"LC_ALL",
		"NO_COLOR",
		"PATH",
		"PIP_DISABLE_PIP_VERSION_CHECK",
		"PYTHONDONTWRITEBYTECODE",
		"TERM",
		"TZ",
		"ZEPHYR_CELL",
		"ZEPHYR_CELL_VERSION",
		"ZEPHYR_ENGINE",
		"ZEPHYR_SESSION_ID",
		"npm_config_update_notifier",
	}
}
