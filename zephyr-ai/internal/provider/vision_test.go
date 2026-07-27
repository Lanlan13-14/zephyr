package provider

import "testing"

func TestDecodeDataURL(t *testing.T) {
	mime, data, ok := DecodeDataURL("data:image/webp;base64,YWJj")
	if !ok || mime != "image/webp" || data != "YWJj" {
		t.Fatalf("unexpected decode: %q %q %v", mime, data, ok)
	}
	for _, value := range []string{"https://example.test/a.png", "data:text/html;base64,YQ==", "data:image/png,abc"} {
		if _, _, ok := DecodeDataURL(value); ok {
			t.Fatalf("must reject %q", value)
		}
	}
}
