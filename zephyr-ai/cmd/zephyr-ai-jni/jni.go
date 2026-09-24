//go:build cgo

package main

/*
#include <jni.h>
#include <stdlib.h>
#include <string.h>
*/
import "C"
import (
	"encoding/json"
	"unsafe"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/embedded"
)

//export Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeInit
func Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeInit(env *C.JNIEnv, class C.jclass, jConfig C.jstring) C.jstring {
	cConfig := C.GetStringUTFChars(env, jConfig, nil)
	defer C.ReleaseStringUTFChars(env, jConfig, cConfig)

	res, err := embedded.InitGlobal(C.GoString(cConfig))
	if err != nil {
		res = jniErrorJSON(err)
	}
	cRes := C.CString(res)
	defer C.free(unsafe.Pointer(cRes))
	return C.NewStringUTF(env, cRes)
}

//export Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeDispatch
func Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeDispatch(env *C.JNIEnv, class C.jclass, jMethod, jPath, jHeaders, jBody C.jstring) C.jstring {
	cMethod := C.GetStringUTFChars(env, jMethod, nil)
	defer C.ReleaseStringUTFChars(env, jMethod, cMethod)
	method := C.GoString(cMethod)

	cPath := C.GetStringUTFChars(env, jPath, nil)
	defer C.ReleaseStringUTFChars(env, jPath, cPath)
	path := C.GoString(cPath)

	var headers, body string
	if jHeaders != nil {
		cHeaders := C.GetStringUTFChars(env, jHeaders, nil)
		headers = C.GoString(cHeaders)
		C.ReleaseStringUTFChars(env, jHeaders, cHeaders)
	}
	if jBody != nil {
		cBody := C.GetStringUTFChars(env, jBody, nil)
		body = C.GoString(cBody)
		C.ReleaseStringUTFChars(env, jBody, cBody)
	}

	res, err := embedded.DispatchGlobal(method, path, headers, body)
	if err != nil {
		res = jniErrorJSON(err)
	}
	cRes := C.CString(res)
	defer C.free(unsafe.Pointer(cRes))
	return C.NewStringUTF(env, cRes)
}

// jniErrorJSON builds an error envelope that survives err.Error() carrying
// quotes or control characters — raw string concatenation would emit invalid
// JSON and crash the Kotlin-side parser before the caller ever sees the error.
func jniErrorJSON(err error) string {
	b, merr := json.Marshal(map[string]any{"ok": false, "error": err.Error()})
	if merr != nil {
		return `{"ok":false,"error":"jni error marshal failure"}`
	}
	return string(b)
}

//export Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeClose
func Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeClose(env *C.JNIEnv, class C.jclass) {
	embedded.CloseGlobal()
}