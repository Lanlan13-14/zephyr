// Command editorcore-host serves one editorcore session on stdin/stdout.
//
// Each request is one JSON object terminated by a newline. The response is
// one JSON object on its own line. The process owns the only text buffer:
// callers send edits and read the UTF-8 snapshot back. A request of
// {"op":"shutdown"} closes the process after its response.
package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os"

	"github.com/Lanlan13-14/zephyr-ssh/editorcore"
)

func main() {
	session := editorcore.NewSession()
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	enc := json.NewEncoder(out)
	for {
		line, err := in.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				return
			}
			writeErr(enc, out, err)
			return
		}
		var req editorcore.Request
		if err := json.Unmarshal(line, &req); err != nil {
			writeErr(enc, out, err)
			continue
		}
		if req.Op == "shutdown" {
			_ = enc.Encode(editorcore.Response{OK: true})
			_ = out.Flush()
			return
		}
		if err := enc.Encode(session.Call(req)); err != nil {
			return
		}
		if err := out.Flush(); err != nil {
			return
		}
	}
}

func writeErr(enc *json.Encoder, out *bufio.Writer, err error) {
	_ = enc.Encode(editorcore.Response{OK: false, Error: err.Error()})
	_ = out.Flush()
}
