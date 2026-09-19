package mcp

import (
	"encoding/json"
	"testing"
)

func TestBuiltinTools_Count(t *testing.T) {
	tools := BuiltinTools()
	if len(tools) != 5 {
		t.Errorf("want 5 builtin tools, got %d", len(tools))
	}

	names := map[string]bool{
		"cell_exec":            true,
		"cell_read_file":       true,
		"cell_write_file":      true,
		"cell_list_dir":        true,
		"cell_install_package": true,
	}
	for _, tool := range tools {
		if !names[tool.Name] {
			t.Errorf("unexpected tool: %s", tool.Name)
		}
		delete(names, tool.Name)

		// Validate schema is valid JSON
		var schema map[string]interface{}
		if err := json.Unmarshal(tool.InputSchema, &schema); err != nil {
			t.Errorf("tool %s: invalid schema JSON: %v", tool.Name, err)
		}

		// All tools should have descriptions
		if tool.Description == "" {
			t.Errorf("tool %s: empty description", tool.Name)
		}
	}
	for name := range names {
		t.Errorf("missing tool: %s", name)
	}
}

func TestBuiltinTools_SchemaProperties(t *testing.T) {
	tools := BuiltinTools()
	for _, tool := range tools {
		var schema struct {
			Type       string                 `json:"type"`
			Properties map[string]interface{} `json:"properties"`
			Required   []string               `json:"required"`
		}
		if err := json.Unmarshal(tool.InputSchema, &schema); err != nil {
			t.Fatalf("tool %s: %v", tool.Name, err)
		}
		if schema.Type != "object" {
			t.Errorf("tool %s: schema type should be 'object', got %q", tool.Name, schema.Type)
		}
		if len(schema.Properties) == 0 {
			t.Errorf("tool %s: schema should have properties", tool.Name)
		}
		if len(schema.Required) == 0 {
			t.Errorf("tool %s: schema should have required fields", tool.Name)
		}
	}
}

func TestTextResult(t *testing.T) {
	r := TextResult("hello")
	if len(r.Content) != 1 {
		t.Fatal("should have 1 content block")
	}
	if r.Content[0].Type != "text" {
		t.Errorf("type: want text, got %s", r.Content[0].Type)
	}
	if r.Content[0].Text != "hello" {
		t.Errorf("text: want hello, got %s", r.Content[0].Text)
	}
	if r.IsError {
		t.Error("should not be error")
	}
}

func TestErrorResult(t *testing.T) {
	r := ErrorResult("failed")
	if !r.IsError {
		t.Error("should be error")
	}
}

func TestDefaultServerInfo(t *testing.T) {
	info := DefaultServerInfo("0.1.0")
	if info.Name != "zephyr-cell" {
		t.Errorf("name: want zephyr-cell, got %s", info.Name)
	}
	if info.Version != "0.1.0" {
		t.Errorf("version: want 0.1.0, got %s", info.Version)
	}
}
