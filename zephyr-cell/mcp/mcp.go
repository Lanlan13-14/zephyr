// Package mcp implements the MCP (Model Context Protocol) server for Cell (§6.5).
//
// Built-in MCP tools:
//   - exec: Execute a command in the cell
//   - read_file: Read a file from the guest filesystem
//   - write_file: Write a file to the guest filesystem
//   - list_dir: List directory contents
//   - install_package: Install packages via apk
//   - reset: Reset the sandbox to its template state
//
// Tool descriptions include guardrail information (quotas, whitelist semantics)
// so LLMs can make informed decisions.
package mcp

import (
	"encoding/json"
)

// Tool describes an MCP tool with its schema and guardrail documentation.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// ToolResult is the result of an MCP tool invocation.
type ToolResult struct {
	Content []ContentBlock `json:"content"`
	IsError bool           `json:"isError,omitempty"`
}

// ContentBlock is a block of content in a tool result.
type ContentBlock struct {
	Type string `json:"type"` // "text" or "image"
	Text string `json:"text,omitempty"`
}

// TextResult creates a ToolResult with a single text block.
func TextResult(text string) ToolResult {
	return ToolResult{
		Content: []ContentBlock{{Type: "text", Text: text}},
	}
}

// ErrorResult creates an error ToolResult.
func ErrorResult(text string) ToolResult {
	return ToolResult{
		Content: []ContentBlock{{Type: "text", Text: text}},
		IsError: true,
	}
}

// BuiltinTools returns the six built-in MCP tools for Cell (§6.5).
func BuiltinTools() []Tool {
	return []Tool{
		{
			Name: "cell_exec",
			Description: `Execute a command in the Cell sandboxed Linux environment.

Guardrails:
- Commands run in an isolated Alpine Linux environment
- Wall-clock timeout: 10 minutes (configurable)
- Output truncated at 100KB; excess written to /cell/outbox/
- Same-cell commands are serialized (use separate cells for parallelism)
- Persistent shell mode available: cwd and env persist across calls
- Network: egress whitelist only (default: no network)
- All executions are audited`,
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"command": {
						"type": "string",
						"description": "The shell command to execute"
					},
					"persistent": {
						"type": "boolean",
						"description": "Run in persistent shell (cwd/env persist across calls)",
						"default": false
					},
					"cwd": {
						"type": "string",
						"description": "Working directory (guest path, must be under /cell/)"
					},
					"timeout_seconds": {
						"type": "integer",
						"description": "Wall-clock timeout in seconds (default: 600)"
					}
				},
				"required": ["command"]
			}`),
		},
		{
			Name: "cell_read_file",
			Description: `Read a file from the Cell guest filesystem.

The file must be under a mounted path (/cell/workspace, /cell/outbox, etc.).
Host filesystem is physically unreachable from the guest.
Maximum read size: 100KB inline; larger files return a reference.`,
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"path": {
						"type": "string",
						"description": "Guest path to read (must be under /cell/)"
					},
					"offset": {
						"type": "integer",
						"description": "Byte offset to start reading from",
						"default": 0
					},
					"limit": {
						"type": "integer",
						"description": "Maximum bytes to read (default: 102400)"
					}
				},
				"required": ["path"]
			}`),
		},
		{
			Name: "cell_write_file",
			Description: `Write content to a file in the Cell guest filesystem.

The path must be under a writable mount (/cell/workspace, /cell/tmp, etc.).
Creates parent directories if they don't exist.
Maximum write size per call: 10MB.`,
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"path": {
						"type": "string",
						"description": "Guest path to write (must be under /cell/)"
					},
					"content": {
						"type": "string",
						"description": "File content to write"
					},
					"append": {
						"type": "boolean",
						"description": "Append to existing file instead of overwriting",
						"default": false
					}
				},
				"required": ["path", "content"]
			}`),
		},
		{
			Name: "cell_list_dir",
			Description: `List the contents of a directory in the Cell guest filesystem.

Returns file names, sizes, types, and modification times.
The path must be under a mounted directory.`,
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"path": {
						"type": "string",
						"description": "Guest directory path to list (must be under /cell/)"
					}
				},
				"required": ["path"]
			}`),
		},
		{
			Name: "cell_install_package",
			Description: `Install packages in the Cell environment using apk (Alpine Package Keeper).

The package manager is always apk across all six platforms.
Installed packages persist in the user layer for the session.
Network access is required (egress whitelist must include Alpine repositories).`,
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"packages": {
						"type": "array",
						"items": {"type": "string"},
						"description": "Package names to install (e.g., [\"python3\", \"git\"])"
					}
				},
				"required": ["packages"]
			}`),
		},
		{
			Name: "cell_reset",
			Description: `Reset the Cell sandbox to its original template state.

This is destructive for session-local state: running processes, persistent
shell state, /cell/workspace, /cell/inbox, /cell/outbox, and /cell/tmp are
removed and recreated. Cross-session shared paths under /cell/shared are
preserved. The Cell and session IDs remain unchanged. Reset is safe to repeat
and is append-only audited.`,
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {},
				"additionalProperties": false
			}`),
		},
	}
}

// ServerInfo describes the MCP server.
type ServerInfo struct {
	Name         string `json:"name"`
	Version      string `json:"version"`
	Capabilities struct {
		Tools struct{} `json:"tools"`
	} `json:"capabilities"`
}

// DefaultServerInfo returns the MCP server metadata.
func DefaultServerInfo(version string) ServerInfo {
	return ServerInfo{
		Name:    "zephyr-cell",
		Version: version,
	}
}
