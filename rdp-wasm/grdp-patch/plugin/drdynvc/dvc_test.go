package drdynvc

import (
	"testing"
)

type testDvcHandler struct{ got [][]byte }

func (h *testDvcHandler) Process(p []byte) { h.got = append(h.got, append([]byte(nil), p...)) }

type testDvcSender struct{ sent [][]byte }

func (s *testDvcSender) SendToChannel(_ string, p []byte) (int, error) {
	s.sent = append(s.sent, append([]byte(nil), p...))
	return len(p), nil
}

type senderAdapter struct{ s *testDvcSender }

func (a senderAdapter) SendToChannel(name string, p []byte) (int, error) {
	return a.s.SendToChannel(name, p)
}

func makeDvcDataFirst(id byte, total byte, fragment string) []byte {
	return append([]byte{id, total}, []byte(fragment)...)
}

func TestDataFirstAndContinuationExactLength(t *testing.T) {
	c := NewDvcClient()
	h := &testDvcHandler{}
	c.channelById[7] = &dvcChannelInfo{id: 7, cbChId: 0, handler: h}
	c.processDataFirst(&DvcHeader{cmd: DYNVC_DATA_FIRST, sp: 0, cbChId: 0}, makeDvcDataFirst(7, 6, "abc"))
	c.processData(&DvcHeader{cmd: DYNVC_DATA, cbChId: 0}, append([]byte{7}, []byte("def")...))
	if len(h.got) != 1 || string(h.got[0]) != "abcdef" {
		t.Fatalf("got %q", h.got)
	}
}

func TestDataFirstRejectsOverflow(t *testing.T) {
	c := NewDvcClient()
	h := &testDvcHandler{}
	c.channelById[7] = &dvcChannelInfo{id: 7, cbChId: 0, handler: h}
	c.processDataFirst(&DvcHeader{cmd: DYNVC_DATA_FIRST, sp: 0, cbChId: 0}, makeDvcDataFirst(7, 3, "four"))
	if len(h.got) != 0 {
		t.Fatalf("processed overflow %q", h.got)
	}
}

func TestDataContinuationRejectsOverflow(t *testing.T) {
	c := NewDvcClient()
	h := &testDvcHandler{}
	c.channelById[7] = &dvcChannelInfo{id: 7, cbChId: 0, handler: h}
	c.processDataFirst(&DvcHeader{cmd: DYNVC_DATA_FIRST, sp: 0, cbChId: 0}, makeDvcDataFirst(7, 5, "abc"))
	c.processData(&DvcHeader{cmd: DYNVC_DATA, cbChId: 0}, append([]byte{7}, []byte("def")...))
	if len(h.got) != 0 {
		t.Fatalf("processed overflow %q", h.got)
	}
	if _, ok := c.reassembly[7]; ok {
		t.Fatal("overflow state not discarded")
	}
}

// senderAdapter is retained for CAPS response fixture tests.
