//go:build cgo

package main

/*
#include <jni.h>
#include <stdlib.h>
#include <string.h>

// C-mode JNI accessors: the NDK's jni.h exposes functions through the
// JNIEnv function-pointer table, not as direct C symbols, so cgo cannot
// call them as C.GetStringUTFChars. These shims dereference the table.
static jstring new_string_utf(JNIEnv *env, const char *s) {
    return (*env)->NewStringUTF(env, s);
}

static const char *get_string_utf_chars(JNIEnv *env, jstring s) {
    return (*env)->GetStringUTFChars(env, s, NULL);
}

static void release_string_utf_chars(JNIEnv *env, jstring s, const char *c) {
    (*env)->ReleaseStringUTFChars(env, s, c);
}
*/
import "C"
import (
	"encoding/json"
	"unsafe"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/embedded"
)

//export Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeInit
func Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeInit(env *C.JNIEnv, class C.jclass, jConfig C.jstring) C.jstring {
	cConfig := C.get_string_utf_chars(env, jConfig)
	defer C.release_string_utf_chars(env, jConfig, cConfig)

	res, err := embedded.InitGlobal(C.GoString(cConfig))
	if err != nil {
		res = jniErrorJSON(err)
	}
	cRes := C.CString(res)
	defer C.free(unsafe.Pointer(cRes))
	return C.new_string_utf(env, cRes)
}

//export Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeDispatch
func Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeDispatch(env *C.JNIEnv, class C.jclass, jMethod, jPath, jHeaders, jBody C.jstring) C.jstring {
	cMethod := C.get_string_utf_chars(env, jMethod)
	defer C.release_string_utf_chars(env, jMethod, cMethod)
	method := C.GoString(cMethod)

	cPath := C.get_string_utf_chars(env, jPath)
	defer C.release_string_utf_chars(env, jPath, cPath)
	path := C.GoString(cPath)

	var headers, body string
	if jHeaders != nil {
		cHeaders := C.get_string_utf_chars(env, jHeaders)
		headers = C.GoString(cHeaders)
		C.release_string_utf_chars(env, jHeaders, cHeaders)
	}
	if jBody != nil {
		cBody := C.get_string_utf_chars(env, jBody)
		body = C.GoString(cBody)
		C.release_string_utf_chars(env, jBody, cBody)
	}

	res, err := embedded.DispatchGlobal(method, path, headers, body)
	if err != nil {
		res = jniErrorJSON(err)
	}
	cRes := C.CString(res)
	defer C.free(unsafe.Pointer(cRes))
	return C.new_string_utf(env, cRes)
}

//export Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeClose
func Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeClose(env *C.JNIEnv, class C.jclass) {
	embedded.CloseGlobal()
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