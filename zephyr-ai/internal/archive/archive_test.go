package archive

import (
	"path/filepath"
	"testing"
)

func TestPutSearchGet(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "a"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	id, err := st.Put(Entry{
		SessionID: "s1", UserID: "u1", Kind: "fold",
		Role: "tool", Name: "remote_execute",
		Content: "systemctl status nginx failed with exit 3 on prod-web",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = st.Put(Entry{
		SessionID: "s1", UserID: "u1", Kind: "tool_snip",
		Content: "unrelated hello world",
	})

	hits, err := st.Search("u1", "s1", "nginx prod", "session", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) < 1 || hits[0].ID != id {
		t.Fatalf("hits %+v", hits)
	}
	e, err := st.Get("u1", id)
	if err != nil {
		t.Fatal(err)
	}
	if e.Name != "remote_execute" {
		t.Fatal(e.Name)
	}
}
