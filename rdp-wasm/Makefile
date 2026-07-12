WASM_OUT      = ../public/vendor/rdp-wasm/main.wasm
WASM_EXEC_SRC = ../public/vendor/rdp-wasm/wasm_exec.js
WASM_EXEC_OUT = ../public/vendor/rdp-wasm/wasm_exec.mjs
GOROOT       := $(shell go env GOROOT)

WASM_SRCS  := $(wildcard *.go) go.mod go.sum

.PHONY: all clean wasm wasm_exec

$(WASM_EXEC_OUT):
	@mkdir -p $(dir $@)
	cp "$(GOROOT)/lib/wasm/wasm_exec.js" $(WASM_EXEC_SRC) 2>/dev/null || \
	cp "$(GOROOT)/misc/wasm/wasm_exec.js" $(WASM_EXEC_SRC)
	node ../scripts/build-go-wasm-esm.mjs $(WASM_EXEC_SRC) $@
	rm -f $(WASM_EXEC_SRC)

$(WASM_OUT): $(WASM_SRCS)
	@mkdir -p $(dir $@)
	GOOS=js GOARCH=wasm go build -o $(WASM_OUT) .

wasm: $(WASM_OUT)

wasm_exec: $(WASM_EXEC_OUT)

all: wasm_exec wasm

clean:
	rm -f $(WASM_OUT) $(WASM_EXEC_SRC) $(WASM_EXEC_OUT)
