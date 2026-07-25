package main

import (
	"fmt"
	"testing"
)

func TestIsRetryableAgentError(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{nil, false},
		{&zft2Error{Code: "busy", Retryable: true}, true},
		{&zft2Error{Code: "timeout", Retryable: true}, true},
		{&zft2Error{Code: "backpressure", Retryable: true}, true},
		{&zft2Error{Code: "io_error", Retryable: false}, true},
		{&zft2Error{Code: "not_found", Retryable: false}, false},
		{&zft2Error{Code: "read_only", Retryable: false}, false},
		{fmt.Errorf("file transfer websocket backpressure timeout"), true},
		{fmt.Errorf("file transfer request window is full"), true},
		{fmt.Errorf("file transfer is unavailable"), false},
	}
	for _, tc := range cases {
		if got := isRetryableAgentError(tc.err); got != tc.want {
			t.Fatalf("isRetryableAgentError(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestAgentRetryConstants(t *testing.T) {
	if agentRequestMaxAttempts < 3 {
		t.Fatalf("agentRequestMaxAttempts = %d, want >= 3", agentRequestMaxAttempts)
	}
	if agentRequestRetryBase <= 0 {
		t.Fatal("agentRequestRetryBase must be positive")
	}
}
