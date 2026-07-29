package agent

import (
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestMergeUsageSnapshotKeepsLatestNonZeroFields(t *testing.T) {
	var got provider.Usage
	mergeUsageSnapshot(&got, &provider.Usage{InputTokens: 10, CacheReadTokens: 2, LatestContextTokens: 12})
	mergeUsageSnapshot(&got, &provider.Usage{InputTokens: 10, OutputTokens: 3, CacheReadTokens: 2, LatestContextTokens: 12})
	if got.InputTokens != 10 || got.OutputTokens != 3 || got.CacheReadTokens != 2 || got.LatestContextTokens != 12 {
		t.Fatalf("usage=%+v", got)
	}
}
