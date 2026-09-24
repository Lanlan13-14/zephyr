//go:build cgo

package main

/*
#include <jni.h>
#include <stdlib.h>
#include <string.h>
*/
import "C"
import (
	"unsafe"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/embedded"
)

//export Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeInit
func Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeInit(env *C.JNIEnv, class C.jclass, jConfig C.jstring) C.jstring {
	cConfig := C.GetStringUTFChars(env, jConfig, nil)
	defer C.ReleaseStringUTFChars(env, jConfig, cConfig)

	configStr := C.GoString(cConfig)
	res, err := embedded.InitGlobal(configStr)
	if err != nil {
		res = `{"ok":false,"error":"` + err.Error() + `"}`
	}
	cRes := C.CString(res)
	defer C.free(unsafe.Pointer(cRes))
	return C.NewStringUTF(env, cRes)
}

//export Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeDispatch
func Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeDispatch(env *C.JNIEnv, class C.jclass, jMethod, jPath, jHeaders, jBody C.jstring) C.jstring {
	cMethod := C.GetStringUTFChars(env, jMethod, nil)
	defer C.ReleaseStringUTFChars(env, jMethod, cMethod)
	cPath := C.GetStringUTFChars(env, jPath, nil)
	defer C.ReleaseStringUTFChars(env, jPath, cPath)

	var headersStr, bodyStr string
	if jHeaders != nil {
		cHeaders := C.GetStringUTFChars(env, jHeaders, nil)
		headersStr = C.GoString(cHeaders)
		C.ReleaseStringUTFChars(env, jHeaders, cHeaders)
	}
	if jBody != nil {
		cBody := C.GetStringUTFChars(env, jBody, nil)
		bodyStr = C.GoString(cBody)
		C.ReleaseStringUTFChars(env, jBody, cBody)
	}

	res, err := embedded.DispatchGlobal(C.GoString(cMethod), C.GoString(cPath), headersStr, bodyStr)
	if err != nil {
		res = `{"statusCode":500,"error":"` + err.Error() + `"}`
	}
	cRes := C.CString(res)
	defer C.free(unsafe.Pointer(cRes))
	return C.NewStringUTF(env, cRes)
}

//export Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeClose
func Java_one_zephyr_mobile_app_EmbeddedAiRuntimeJni_nativeClose(env *C.JNIEnv, class C.jclass) {
	embedded.CloseGlobal()
}
