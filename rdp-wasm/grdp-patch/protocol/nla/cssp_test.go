package nla_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/asn1"
	"testing"

	"github.com/nakagami/grdp/protocol/nla"
)

func TestEncodeDERTRequestVersion6CarriesNonce(t *testing.T) {
	ntlm := nla.NewNTLMv2("", "", "")
	nonce := bytes.Repeat([]byte{0x5a}, nla.CredSSPClientNonceLength)
	result := nla.EncodeDERTRequestVersion(nla.CredSSPVersion, []nla.Message{ntlm.GetNegotiateMessage()}, nil, nil, nonce)
	var request nla.TSRequest
	rest, err := asn1.Unmarshal(result, &request)
	if err != nil || len(rest) != 0 {
		t.Fatalf("decode TSRequest: rest=%d err=%v", len(rest), err)
	}
	if request.Version != 6 {
		t.Fatalf("version=%d", request.Version)
	}
	if !bytes.Equal(request.ClientNonce, nonce) {
		t.Fatalf("nonce mismatch: %x", request.ClientNonce)
	}
	if len(request.NegoTokens) != 1 || len(request.NegoTokens[0].Data) == 0 {
		t.Fatal("NTLM negotiate token missing")
	}
}

func TestCredSSPBindingHashMatchesSpecification(t *testing.T) {
	nonce := bytes.Repeat([]byte{0x11}, nla.CredSSPClientNonceLength)
	publicKey := []byte{0x30, 0x03, 0x01, 0x02, 0x03}
	clientExpected := sha256.Sum256(append(append([]byte("CredSSP Client-To-Server Binding Hash\x00"), nonce...), publicKey...))
	serverExpected := sha256.Sum256(append(append([]byte("CredSSP Server-To-Client Binding Hash\x00"), nonce...), publicKey...))
	if got := nla.CredSSPBindingHash(true, nonce, publicKey); !bytes.Equal(got, clientExpected[:]) {
		t.Fatalf("client binding hash mismatch: %x", got)
	}
	if got := nla.CredSSPBindingHash(false, nonce, publicKey); !bytes.Equal(got, serverExpected[:]) {
		t.Fatalf("server binding hash mismatch: %x", got)
	}
}

func TestDecodeDERTRequestPreservesPeerErrorAndVersion(t *testing.T) {
	encoded, err := asn1.Marshal(nla.TSRequest{Version: 6, ErrorCode: int(0xc000006d)})
	if err != nil {
		t.Fatal(err)
	}
	request, err := nla.DecodeDERTRequest(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if request.Version != 6 || uint32(request.ErrorCode) != 0xc000006d {
		t.Fatalf("decoded request=%+v", request)
	}
}
