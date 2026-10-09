//go:build cgo

// Command editorcore-jni builds libeditorcore_jni.so with -buildmode=c-shared.
// Android calls the same editorcore session the desktop host calls.
package main

/*
#include <stdlib.h>
*/
import "C"
import (
	"encoding/json"
	"unsafe"

	"github.com/Lanlan13-14/zephyr-ssh/editorcore"
)

var session = editorcore.NewSession()

//export editorcore_call
func editorcore_call(request *C.char) *C.char {
	var req editorcore.Request
	if err := json.Unmarshal([]byte(C.GoString(request)), &req); err != nil {
		return cString(editorcore.Response{OK: false, Error: err.Error()})
	}
	return cString(session.Call(req))
}

//export editorcore_free
func editorcore_free(ptr *C.char) { C.free(unsafe.Pointer(ptr)) }

func cString(resp editorcore.Response) *C.char {
	body, err := json.Marshal(resp)
	if err != nil {
		body = []byte(`{"ok":false,"error":"marshal failed"}`)
	}
	return C.CString(string(body))
}

func main() {}
