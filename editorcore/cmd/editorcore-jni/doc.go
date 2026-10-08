// Package main is the Android c-shared entry of editorcore.
//
// The symbols live in main.go and build only with cgo. This file keeps the
// package visible to `go test` when cgo is unavailable: the text behaviour is
// covered by the editorcore module, and both hosts call that same module.
package main
