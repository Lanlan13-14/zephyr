package main

/*
#include <stdint.h>
#include <stdlib.h>
*/
import "C"

import (
	"sync"
	"unsafe"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/mobile"
)

var runtimes = struct {
	sync.Mutex
	next   uint64
	values map[uint64]*mobile.Runtime
}{values: make(map[uint64]*mobile.Runtime)}

//export ZephyrLinkCreate
func ZephyrLinkCreate() C.uint64_t {
	runtimes.Lock()
	defer runtimes.Unlock()
	if len(runtimes.values) >= 16 {
		return 0
	}
	runtimes.next++
	if runtimes.next == 0 {
		runtimes.next++
	}
	runtimes.values[runtimes.next] = mobile.New()
	return C.uint64_t(runtimes.next)
}

//export ZephyrLinkCall
func ZephyrLinkCall(handle C.uint64_t, path *C.char, input *C.char, size C.int) *C.char {
	if path == nil || input == nil || size < 0 || int(size) > mobile.MaxBody {
		return nil
	}
	route := C.GoString(path)
	if len(route) > 64 {
		return nil
	}
	runtimes.Lock()
	runtime := runtimes.values[uint64(handle)]
	runtimes.Unlock()
	if runtime == nil {
		return nil
	}
	data := C.GoBytes(unsafe.Pointer(input), size)
	defer clear(data)
	result := runtime.Call(route, data)
	defer clear(result)
	return C.CString(string(result))
}

//export ZephyrLinkDestroy
func ZephyrLinkDestroy(handle C.uint64_t) {
	runtimes.Lock()
	runtime := runtimes.values[uint64(handle)]
	delete(runtimes.values, uint64(handle))
	runtimes.Unlock()
	if runtime != nil {
		runtime.Close()
	}
}

//export ZephyrLinkBuildInfo
func ZephyrLinkBuildInfo() *C.char { return C.CString(string(mobile.BuildInfo())) }

//export ZephyrLinkFree
func ZephyrLinkFree(value *C.char) { C.free(unsafe.Pointer(value)) }

func main() {}
