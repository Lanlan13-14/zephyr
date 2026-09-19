package cell

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

// ComputeTemplateID calculates the content-addressed ID for a template.
// The ID is SHA-256 of the canonical JSON of (Layers + Env + Limits + Offloads + Network).
func ComputeTemplateID(tpl *Template) string {
	// Build canonical representation
	canonical := struct {
		Layers   []string          `json:"layers"`
		Env      map[string]string `json:"env"`
		Limits   Limits            `json:"limits"`
		Offloads []string          `json:"offloads"`
		Network  NetworkPolicy     `json:"network"`
	}{
		Layers:   tpl.Layers,
		Env:      tpl.Env,
		Limits:   tpl.Limits,
		Offloads: sortedCopy(tpl.Offloads),
		Network:  tpl.Network,
	}

	data, err := json.Marshal(canonical)
	if err != nil {
		// Shouldn't happen with these types, but degrade gracefully
		return ""
	}

	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func sortedCopy(s []string) []string {
	if s == nil {
		return nil
	}
	c := make([]string, len(s))
	copy(c, s)
	sort.Strings(c)
	return c
}

// EnsureID computes and sets the template ID if not already set.
func (t *Template) EnsureID() {
	if t.ID == "" {
		t.ID = ComputeTemplateID(t)
	}
}

// L2CompatTemplate returns the default "l2-compat" template that inherits
// L2's restricted exec discipline (§2.6).
func L2CompatTemplate() Template {
	limits := DefaultLimits()
	limits.MaxOutputKB = 256 // L2 had 256KB

	return Template{
		Layers:   nil, // resolved at boot
		Env:      nil, // uses defaults
		Limits:   limits,
		Offloads: []string{}, // all offloads denied by default
		Network:  DefaultNetworkPolicy(),
	}
}

// FullTemplate returns a template with all capabilities enabled.
// Suitable for trusted environments or development.
func FullTemplate() Template {
	return Template{
		Layers:   nil,
		Env:      nil,
		Limits:   DefaultLimits(),
		Offloads: OffloadCommands, // all offloads enabled
		Network: NetworkPolicy{
			AllowedDomains: []string{"*"},
			BlockMetadata:  true,
		},
	}
}
