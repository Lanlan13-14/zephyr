//go:build js && wasm

package main

import "testing"

func TestQueueDepthForPreferences(t *testing.T) {
	tests := []struct {
		quality string
		fps     int
		want    uint32
	}{
		{"balanced", 30, 16},
		{"balanced", 45, 8},
		{"balanced", 60, 4},
		{"balanced", 144, 0},
		{"quality", 30, 8},
		{"quality", 60, 2},
		{"quality", 144, 0},
		{"performance", 30, 24},
		{"performance", 60, 10},
		{"performance", 144, 2},
	}
	for _, tc := range tests {
		if got := queueDepthForPreferences(tc.quality, tc.fps); got != tc.want {
			t.Fatalf("queueDepthForPreferences(%q, %d)=%d, want %d", tc.quality, tc.fps, got, tc.want)
		}
	}
}
