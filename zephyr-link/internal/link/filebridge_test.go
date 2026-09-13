package link

import (
    "testing"

    "github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

func TestFileBridgeUsesTheExistingSealedEndpoint(t *testing.T) {
    device, host, err := Pair()
    if err != nil { t.Fatal(err) }
    env, err := device.Send(codec.KindFileBridge, map[string]any{
        "op": "stat", "params": map[string]any{"path": "demo.txt"},
    }, false)
    if err != nil { t.Fatal(err) }
    if len(env.CT) == 0 || len(env.Tag) == 0 || len(env.IV) == 0 { t.Fatal("file bridge frame was not sealed") }
    frame, err := host.Receive(env)
    if err != nil { t.Fatal(err) }
    if frame.Kind != codec.KindFileBridge { t.Fatalf("kind=%d", frame.Kind) }
    if string(frame.Body) == "" { t.Fatal("empty decoded body") }
}

func TestFileBridgeCannotUseSecretCompressionLane(t *testing.T) {
	device, host, err := Pair()
	if err != nil {
		t.Fatal(err)
	}
	env, err := device.Send(codec.KindFileBridge, map[string]any{"op": "readBinary"}, true)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := host.Receive(env)
	if err != nil {
		t.Fatal(err)
	}
	d := NewDispatcher()
	d.Register(codec.KindFileBridge, func(_ *FrameContext, _ *codec.Frame) (int, any, bool, error) {
		return codec.KindFileBridge, map[string]any{"ok": true}, false, nil
	})
	if _, _, _, err := d.Dispatch(&FrameContext{}, frame); err == nil {
		t.Fatal("file bridge must be rejected when flagged secret")
	}
}
