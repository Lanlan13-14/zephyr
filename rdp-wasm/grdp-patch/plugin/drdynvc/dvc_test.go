package drdynvc

import (
	"encoding/binary"
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

func TestExplicitRejectionUsesFreeRDPStatusNotFound(t *testing.T) {
	c := NewDvcClient()
	sender := &testDvcSender{}
	c.Sender(senderAdapter{s: sender})
	c.capsReady = true
	const name = "Microsoft::Windows::RDS::Video::Control::v08.01"
	c.RegisterRejectedChannel(name)
	var observed []string
	c.SetProtocolObserver(func(event string) { observed = append(observed, event) })

	payload := append([]byte{7}, []byte(name)...)
	payload = append(payload, 0)
	c.processCreateReq(&DvcHeader{cmd: DYNVC_CREATE_REQ, cbChId: 0}, payload)

	if len(sender.sent) != 1 {
		t.Fatalf("sent %d responses, want 1", len(sender.sent))
	}
	response := sender.sent[0]
	if len(response) != 6 || response[0] != 0x10 || response[1] != 7 {
		t.Fatalf("malformed CREATE_RSP: %x", response)
	}
	if status := binary.LittleEndian.Uint32(response[2:]); status != 0xC0000225 {
		t.Fatalf("CreationStatus = 0x%08x, want STATUS_NOT_FOUND", status)
	}
	want := "drdynvc.reject:" + name + ":status0xc0000225"
	if len(observed) != 2 || observed[0] != "drdynvc.create:"+name || observed[1] != want {
		t.Fatalf("observed %q, want create then %q", observed, want)
	}
}

func TestAcceptedChannelFirstDataDiagnosticIsBoundedAndOnce(t *testing.T) {
	c := NewDvcClient()
	c.capsReady = true
	handler := &testDvcHandler{}
	const name = "Microsoft::Windows::RDS::Video::Control::v08.01"
	c.RegisterHandler(name, handler)
	c.channelById[7] = &dvcChannelInfo{name: name, id: 7, cbChId: 0, handler: handler}
	var observed []string
	c.SetProtocolObserver(func(event string) { observed = append(observed, event) })

	payload := append([]byte{7}, make([]byte, 32)...)
	for i := 1; i < len(payload); i++ {
		payload[i] = byte(i)
	}
	hdr := &DvcHeader{cmd: DYNVC_DATA, cbChId: 0}
	c.processData(hdr, payload)
	c.processData(hdr, payload)

	if len(observed) != 1 {
		t.Fatalf("observed %d events, want 1: %v", len(observed), observed)
	}
	want := "drdynvc.data-first:id7:" + name + ":data:len32:head0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
	if observed[0] != want {
		t.Fatalf("event = %q, want %q", observed[0], want)
	}
	if len(handler.got) != 2 {
		t.Fatalf("handler calls = %d, want 2", len(handler.got))
	}
}

func TestUnknownChannelFirstDataDiagnosticIsBounded(t *testing.T) {
	c := NewDvcClient()
	var observed []string
	c.SetProtocolObserver(func(event string) { observed = append(observed, event) })
	hdr := &DvcHeader{cmd: DYNVC_DATA, cbChId: 0}

	for id := byte(1); id <= maxUnknownDataObservations+3; id++ {
		payload := []byte{id, 0xaa, 0xbb}
		c.processData(hdr, payload)
		c.processData(hdr, payload)
	}

	if len(observed) != maxUnknownDataObservations {
		t.Fatalf("observed %d unknown-ID events, want %d: %v", len(observed), maxUnknownDataObservations, observed)
	}
	if want := "drdynvc.data-unknown:id1:data:len2:headaabb"; observed[0] != want {
		t.Fatalf("first event = %q, want %q", observed[0], want)
	}
}
