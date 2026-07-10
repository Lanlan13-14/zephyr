package nla

import (
	"bytes"
	"crypto/md5"
	"crypto/rc4"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	"github.com/lunixbochs/struc"
	"github.com/nakagami/grdp/core"
)

const (
	WINDOWS_MINOR_VERSION_0 = 0x00
	WINDOWS_MINOR_VERSION_1 = 0x01
	WINDOWS_MINOR_VERSION_2 = 0x02
	WINDOWS_MINOR_VERSION_3 = 0x03

	WINDOWS_MAJOR_VERSION_5 = 0x05
	WINDOWS_MAJOR_VERSION_6 = 0x06
	NTLMSSP_REVISION_W2K3   = 0x0F
)

const (
	MsvAvEOL             = 0x0000
	MsvAvNbComputerName  = 0x0001
	MsvAvNbDomainName    = 0x0002
	MsvAvDnsComputerName = 0x0003
	MsvAvDnsDomainName   = 0x0004
	MsvAvDnsTreeName     = 0x0005
	MsvAvFlags           = 0x0006
	MsvAvTimestamp       = 0x0007
	MsvAvSingleHost      = 0x0008
	MsvAvTargetName      = 0x0009
	MsvChannelBindings   = 0x000A
)

type AVPair struct {
	Id    uint16 `struc:"little"`
	Len   uint16 `struc:"little,sizeof=Value"`
	Value []byte `struc:"little"`
}

const (
	NTLMSSP_NEGOTIATE_56                       = 0x80000000
	NTLMSSP_NEGOTIATE_KEY_EXCH                 = 0x40000000
	NTLMSSP_NEGOTIATE_128                      = 0x20000000
	NTLMSSP_NEGOTIATE_VERSION                  = 0x02000000
	NTLMSSP_NEGOTIATE_TARGET_INFO              = 0x00800000
	NTLMSSP_REQUEST_NON_NT_SESSION_KEY         = 0x00400000
	NTLMSSP_NEGOTIATE_IDENTIFY                 = 0x00100000
	NTLMSSP_NEGOTIATE_EXTENDED_SESSIONSECURITY = 0x00080000
	NTLMSSP_TARGET_TYPE_SERVER                 = 0x00020000
	NTLMSSP_TARGET_TYPE_DOMAIN                 = 0x00010000
	NTLMSSP_NEGOTIATE_ALWAYS_SIGN              = 0x00008000
	NTLMSSP_NEGOTIATE_OEM_WORKSTATION_SUPPLIED = 0x00002000
	NTLMSSP_NEGOTIATE_OEM_DOMAIN_SUPPLIED      = 0x00001000
	NTLMSSP_NEGOTIATE_NTLM                     = 0x00000200
	NTLMSSP_NEGOTIATE_LM_KEY                   = 0x00000080
	NTLMSSP_NEGOTIATE_DATAGRAM                 = 0x00000040
	NTLMSSP_NEGOTIATE_SEAL                     = 0x00000020
	NTLMSSP_NEGOTIATE_SIGN                     = 0x00000010
	NTLMSSP_REQUEST_TARGET                     = 0x00000004
	NTLM_NEGOTIATE_OEM                         = 0x00000002
	NTLMSSP_NEGOTIATE_UNICODE                  = 0x00000001
)

type NVersion struct {
	ProductMajorVersion uint8   `struc:"little"`
	ProductMinorVersion uint8   `struc:"little"`
	ProductBuild        uint16  `struc:"little"`
	Reserved            [3]byte `struc:"little"`
	NTLMRevisionCurrent uint8   `struc:"little"`
}

func NewNVersion() NVersion {
	return NVersion{
		ProductMajorVersion: WINDOWS_MAJOR_VERSION_6,
		ProductMinorVersion: WINDOWS_MINOR_VERSION_0,
		ProductBuild:        6002,
		NTLMRevisionCurrent: NTLMSSP_REVISION_W2K3,
	}
}

type Message interface {
	Serialize() []byte
}

type NegotiateMessage struct {
	Signature               [8]byte  `struc:"little"`
	MessageType             uint32   `struc:"little"`
	NegotiateFlags          uint32   `struc:"little"`
	DomainNameLen           uint16   `struc:"little"`
	DomainNameMaxLen        uint16   `struc:"little"`
	DomainNameBufferOffset  uint32   `struc:"little"`
	WorkstationLen          uint16   `struc:"little"`
	WorkstationMaxLen       uint16   `struc:"little"`
	WorkstationBufferOffset uint32   `struc:"little"`
	Version                 NVersion `struc:"skip"`
	Payload                 [32]byte `struc:"skip"`
}

func NewNegotiateMessage() *NegotiateMessage {
	return &NegotiateMessage{
		Signature:   [8]byte{'N', 'T', 'L', 'M', 'S', 'S', 'P', 0x00},
		MessageType: 0x00000001,
	}
}

func (m *NegotiateMessage) Serialize() []byte {
	if (m.NegotiateFlags & NTLMSSP_NEGOTIATE_VERSION) != 0 {
		m.Version = NewNVersion()
	}
	buff := &bytes.Buffer{}
	struc.Pack(buff, m)

	return buff.Bytes()
}

type ChallengeMessage struct {
	totalLen               int
	Signature              []byte   `struc:"[8]byte"`
	MessageType            uint32   `struc:"little"`
	TargetNameLen          uint16   `struc:"little"`
	TargetNameMaxLen       uint16   `struc:"little"`
	TargetNameBufferOffset uint32   `struc:"little"`
	NegotiateFlags         uint32   `struc:"little"`
	ServerChallenge        [8]byte  `struc:"little"`
	Reserved               [8]byte  `struc:"little"`
	TargetInfoLen          uint16   `struc:"little"`
	TargetInfoMaxLen       uint16   `struc:"little"`
	TargetInfoBufferOffset uint32   `struc:"little"`
	Version                NVersion `struc:"skip"`
	Payload                []byte   `struc:"skip"`
}

func (m *ChallengeMessage) Serialize() []byte {
	buff := &bytes.Buffer{}
	struc.Pack(buff, m)
	if (m.NegotiateFlags & NTLMSSP_NEGOTIATE_VERSION) != 0 {
		struc.Pack(buff, m.Version)
	}
	buff.Write(m.Payload)
	return buff.Bytes()
}

func NewChallengeMessage() *ChallengeMessage {
	return &ChallengeMessage{
		Signature:   []byte{'N', 'T', 'L', 'M', 'S', 'S', 'P', 0x00},
		MessageType: 0x00000002,
	}
}

// total len - payload len
func (m *ChallengeMessage) BaseLen() uint32 {
	return uint32(m.totalLen - len(m.Payload))
}

func (m *ChallengeMessage) getTargetInfo() []byte {
	if m.TargetInfoLen == 0 {
		return make([]byte, 0)
	}
	offset := m.BaseLen()
	start := m.TargetInfoBufferOffset - offset
	return m.Payload[start : start+uint32(m.TargetInfoLen)]
}
func (m *ChallengeMessage) getTargetName() []byte {
	if m.TargetNameLen == 0 {
		return make([]byte, 0)
	}
	offset := m.BaseLen()
	start := m.TargetNameBufferOffset - offset
	return m.Payload[start : start+uint32(m.TargetNameLen)]
}
func (m *ChallengeMessage) getTargetInfoTimestamp(data []byte) []byte {
	r := bytes.NewReader(data)
	for r.Len() > 0 {
		avPair := &AVPair{}
		struc.Unpack(r, avPair)
		if avPair.Id == MsvAvTimestamp {
			return avPair.Value
		}

		if avPair.Id == MsvAvEOL {
			break
		}
	}
	return nil
}

type AuthenticateMessage struct {
	Signature                          [8]byte
	MessageType                        uint32   `struc:"little"`
	LmChallengeResponseLen             uint16   `struc:"little"`
	LmChallengeResponseMaxLen          uint16   `struc:"little"`
	LmChallengeResponseBufferOffset    uint32   `struc:"little"`
	NtChallengeResponseLen             uint16   `struc:"little"`
	NtChallengeResponseMaxLen          uint16   `struc:"little"`
	NtChallengeResponseBufferOffset    uint32   `struc:"little"`
	DomainNameLen                      uint16   `struc:"little"`
	DomainNameMaxLen                   uint16   `struc:"little"`
	DomainNameBufferOffset             uint32   `struc:"little"`
	UserNameLen                        uint16   `struc:"little"`
	UserNameMaxLen                     uint16   `struc:"little"`
	UserNameBufferOffset               uint32   `struc:"little"`
	WorkstationLen                     uint16   `struc:"little"`
	WorkstationMaxLen                  uint16   `struc:"little"`
	WorkstationBufferOffset            uint32   `struc:"little"`
	EncryptedRandomSessionLen          uint16   `struc:"little"`
	EncryptedRandomSessionMaxLen       uint16   `struc:"little"`
	EncryptedRandomSessionBufferOffset uint32   `struc:"little"`
	NegotiateFlags                     uint32   `struc:"little"`
	Version                            NVersion `struc:"little"`
	MIC                                [16]byte `struc:"little"`
	Payload                            []byte   `struc:"skip"`
}

func (m *AuthenticateMessage) BaseLen() uint32 {
	return 88
}

func NewAuthenticateMessage(negFlag uint32, domain, user, workstation []byte,
	lmchallResp, ntchallResp, enRandomSessKey []byte) *AuthenticateMessage {
	msg := &AuthenticateMessage{
		Signature:      [8]byte{'N', 'T', 'L', 'M', 'S', 'S', 'P', 0x00},
		MessageType:    0x00000003,
		NegotiateFlags: negFlag,
	}
	payload := make([]byte, 0, len(lmchallResp)+len(ntchallResp)+len(domain)+len(user)+len(workstation)+len(enRandomSessKey))

	msg.LmChallengeResponseLen = uint16(len(lmchallResp))
	msg.LmChallengeResponseMaxLen = msg.LmChallengeResponseLen
	msg.LmChallengeResponseBufferOffset = msg.BaseLen()
	payload = append(payload, lmchallResp...)

	msg.NtChallengeResponseLen = uint16(len(ntchallResp))
	msg.NtChallengeResponseMaxLen = msg.NtChallengeResponseLen
	msg.NtChallengeResponseBufferOffset = msg.LmChallengeResponseBufferOffset + uint32(msg.LmChallengeResponseLen)
	payload = append(payload, ntchallResp...)

	msg.DomainNameLen = uint16(len(domain))
	msg.DomainNameMaxLen = msg.DomainNameLen
	msg.DomainNameBufferOffset = msg.NtChallengeResponseBufferOffset + uint32(msg.NtChallengeResponseLen)
	payload = append(payload, domain...)

	msg.UserNameLen = uint16(len(user))
	msg.UserNameMaxLen = msg.UserNameLen
	msg.UserNameBufferOffset = msg.DomainNameBufferOffset + uint32(msg.DomainNameLen)
	payload = append(payload, user...)

	msg.WorkstationLen = uint16(len(workstation))
	msg.WorkstationMaxLen = msg.WorkstationLen
	msg.WorkstationBufferOffset = msg.UserNameBufferOffset + uint32(msg.UserNameLen)
	payload = append(payload, workstation...)

	msg.EncryptedRandomSessionLen = uint16(len(enRandomSessKey))
	msg.EncryptedRandomSessionMaxLen = msg.EncryptedRandomSessionLen
	msg.EncryptedRandomSessionBufferOffset = msg.WorkstationBufferOffset + uint32(msg.WorkstationLen)
	payload = append(payload, enRandomSessKey...)

	if (msg.NegotiateFlags & NTLMSSP_NEGOTIATE_VERSION) != 0 {
		msg.Version = NewNVersion()
	}
	msg.Payload = payload

	return msg
}

func (m *AuthenticateMessage) Serialize() []byte {
	buff := &bytes.Buffer{}
	struc.Pack(buff, m)
	buff.Write(m.Payload)
	return buff.Bytes()
}

type NTLMv2 struct {
	domain              string
	user                string
	password            string
	respKeyNT           []byte
	respKeyLM           []byte
	negotiateMessage    *NegotiateMessage
	challengeMessage    *ChallengeMessage
	authenticateMessage *AuthenticateMessage
	enableUnicode       bool
}

func NewNTLMv2(domain, user, password string) *NTLMv2 {
	return &NTLMv2{
		domain:    domain,
		user:      user,
		password:  password,
		respKeyNT: NTOWFv2(password, user, domain),
		respKeyLM: LMOWFv2(password, user, domain),
	}
}

// generate first handshake messgae
func (n *NTLMv2) GetNegotiateMessage() *NegotiateMessage {
	negoMsg := NewNegotiateMessage()
	negoMsg.NegotiateFlags = NTLMSSP_NEGOTIATE_KEY_EXCH |
		NTLMSSP_NEGOTIATE_128 |
		NTLMSSP_NEGOTIATE_EXTENDED_SESSIONSECURITY |
		NTLMSSP_NEGOTIATE_ALWAYS_SIGN |
		NTLMSSP_NEGOTIATE_NTLM |
		NTLMSSP_NEGOTIATE_SEAL |
		NTLMSSP_NEGOTIATE_SIGN |
		NTLMSSP_REQUEST_TARGET |
		NTLMSSP_NEGOTIATE_UNICODE
	n.negotiateMessage = negoMsg
	return n.negotiateMessage
}

// process NTLMv2 Authenticate hash
func (n *NTLMv2) ComputeResponseV2(respKeyNT, respKeyLM, serverChallenge, clientChallenge,
	timestamp, serverInfo []byte) (ntChallResp, lmChallResp, SessBaseKey []byte) {

	// Build the temp blob: 2+6+8+8+4+len(serverInfo) bytes
	temp := make([]byte, 0, 28+len(serverInfo))
	temp = append(temp, 0x01, 0x01) // Responser version, HiResponser version
	temp = append(temp, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
	temp = append(temp, timestamp...)
	temp = append(temp, clientChallenge...)
	temp = append(temp, 0x00, 0x00, 0x00, 0x00)
	temp = append(temp, serverInfo...)

	ntInput := make([]byte, 0, len(serverChallenge)+len(temp))
	ntInput = append(ntInput, serverChallenge...)
	ntInput = append(ntInput, temp...)
	ntProof := HMAC_MD5(respKeyNT, ntInput)

	ntChallResp = make([]byte, 0, len(ntProof)+len(temp))
	ntChallResp = append(ntChallResp, ntProof...)
	ntChallResp = append(ntChallResp, temp...)

	lmInput := make([]byte, 0, len(serverChallenge)+len(clientChallenge))
	lmInput = append(lmInput, serverChallenge...)
	lmInput = append(lmInput, clientChallenge...)
	lmChallResp = HMAC_MD5(respKeyLM, lmInput)
	lmChallResp = append(lmChallResp, clientChallenge...)

	SessBaseKey = HMAC_MD5(respKeyNT, ntProof)
	return
}

func MIC(exportedSessionKey []byte, negotiateMessage, challengeMessage, authenticateMessage Message) []byte {
	neg := negotiateMessage.Serialize()
	chal := challengeMessage.Serialize()
	auth := authenticateMessage.Serialize()
	data := make([]byte, 0, len(neg)+len(chal)+len(auth))
	data = append(data, neg...)
	data = append(data, chal...)
	data = append(data, auth...)
	return HMAC_MD5(exportedSessionKey, data)
}

func concat(bs ...[]byte) []byte {
	return bytes.Join(bs, nil)
}

var (
	clientSigning = concat([]byte("session key to client-to-server signing key magic constant"), []byte{0x00})
	serverSigning = concat([]byte("session key to server-to-client signing key magic constant"), []byte{0x00})
	clientSealing = concat([]byte("session key to client-to-server sealing key magic constant"), []byte{0x00})
	serverSealing = concat([]byte("session key to server-to-client sealing key magic constant"), []byte{0x00})
)

func (n *NTLMv2) GetAuthenticateMessage(s []byte) (*AuthenticateMessage, *NTLMv2Security) {
	slog.Debug("GetAuthenticateMessage", "s", s)

	challengeMsg := &ChallengeMessage{totalLen: len(s)}
	r := bytes.NewReader(s)
	err := struc.Unpack(r, challengeMsg)
	if err != nil {
		slog.Error("GetAuthenticateMessage", "err", err)
		return nil, nil
	}
	if challengeMsg.NegotiateFlags&NTLMSSP_NEGOTIATE_VERSION != 0 {
		version := NVersion{}
		err := struc.Unpack(r, &version)
		if err != nil {
			slog.Error("GetAuthenticateMessage", "err", err)
			return nil, nil
		}
		challengeMsg.Version = version
	}
	challengeMsg.Payload, _ = core.ReadBytes(r.Len(), r)
	n.challengeMessage = challengeMsg
	slog.Debug("GetAuthenticateMessage", "challengeMsg", challengeMsg)

	serverName := challengeMsg.getTargetName()
	serverInfo := challengeMsg.getTargetInfo()
	timestamp := challengeMsg.getTargetInfoTimestamp(serverInfo)
	computeMIC := false
	if timestamp == nil {
		ft := uint64(time.Now().UnixNano()) / 100
		ft += 116444736000000000 // add time between unix & windows offset
		timestamp = make([]byte, 8)
		binary.LittleEndian.PutUint64(timestamp, ft)
	} else {
		computeMIC = true
	}
	slog.Debug("GetAuthenticateMessage", "serverName", core.UnicodeDecode(serverName))
	serverChallenge := challengeMsg.ServerChallenge[:]
	clientChallenge := core.Random(8)
	ntChallengeResponse, lmChallengeResponse, SessionBaseKey := n.ComputeResponseV2(
		n.respKeyNT, n.respKeyLM, serverChallenge, clientChallenge, timestamp, serverInfo)

	exchangeKey := SessionBaseKey
	exportedSessionKey := core.Random(16)
	EncryptedRandomSessionKey := make([]byte, len(exportedSessionKey))
	rc, _ := rc4.NewCipher(exchangeKey)
	rc.XORKeyStream(EncryptedRandomSessionKey, exportedSessionKey)

	if challengeMsg.NegotiateFlags&NTLMSSP_NEGOTIATE_UNICODE != 0 {
		n.enableUnicode = true
	}
	slog.Debug(fmt.Sprintf("user: %s, password:********", n.user))
	domain, user, _ := n.GetEncodedCredentials()

	n.authenticateMessage = NewAuthenticateMessage(challengeMsg.NegotiateFlags,
		domain, user, []byte(""), lmChallengeResponse, ntChallengeResponse, EncryptedRandomSessionKey)

	if computeMIC {
		copy(n.authenticateMessage.MIC[:], MIC(exportedSessionKey, n.negotiateMessage, n.challengeMessage, n.authenticateMessage)[:16])
	}

	md := md5.New()
	//ClientSigningKey
	a := concat(exportedSessionKey, clientSigning)
	md.Write(a)
	ClientSigningKey := md.Sum(nil)
	//ServerSigningKey
	md.Reset()
	a = concat(exportedSessionKey, serverSigning)
	md.Write(a)
	ServerSigningKey := md.Sum(nil)
	//ClientSealingKey
	md.Reset()
	a = concat(exportedSessionKey, clientSealing)
	md.Write(a)
	ClientSealingKey := md.Sum(nil)
	//ServerSealingKey
	md.Reset()
	a = concat(exportedSessionKey, serverSealing)
	md.Write(a)
	ServerSealingKey := md.Sum(nil)

	slog.Debug(fmt.Sprintf("ClientSigningKey:%s", hex.EncodeToString(ClientSigningKey)))
	slog.Debug(fmt.Sprintf("ServerSigningKey:%s", hex.EncodeToString(ServerSigningKey)))
	slog.Debug(fmt.Sprintf("ClientSealingKey:%s", hex.EncodeToString(ClientSealingKey)))
	slog.Debug(fmt.Sprintf("ServerSealingKey:%s", hex.EncodeToString(ServerSealingKey)))

	encryptRC4, _ := rc4.NewCipher(ClientSealingKey)
	decryptRC4, _ := rc4.NewCipher(ServerSealingKey)

	ntlmSec := &NTLMv2Security{encryptRC4, decryptRC4, ClientSigningKey, ServerSigningKey, 0}

	return n.authenticateMessage, ntlmSec
}

func (n *NTLMv2) GetEncodedCredentials() ([]byte, []byte, []byte) {
	if n.enableUnicode {
		return core.UnicodeEncode(n.domain), core.UnicodeEncode(n.user), core.UnicodeEncode(n.password)
	}
	return []byte(n.domain), []byte(n.user), []byte(n.password)
}

type NTLMv2Security struct {
	EncryptRC4 *rc4.Cipher
	DecryptRC4 *rc4.Cipher
	SigningKey []byte
	VerifyKey  []byte
	SeqNum     uint32
}

func (n *NTLMv2Security) GssEncrypt(s []byte) []byte {
	p := make([]byte, len(s))
	n.EncryptRC4.XORKeyStream(p, s)

	// HMAC input: SeqNum(4) + plaintext
	sigInput := make([]byte, 4+len(s))
	binary.LittleEndian.PutUint32(sigInput, n.SeqNum)
	copy(sigInput[4:], s)
	s1 := HMAC_MD5(n.SigningKey, sigInput)[:8]

	checksum := make([]byte, 8)
	n.EncryptRC4.XORKeyStream(checksum, s1)

	// Output: version(4) + checksum(8) + SeqNum(4) + encrypted(len(p))
	out := make([]byte, 16+len(p))
	binary.LittleEndian.PutUint32(out[0:], 0x00000001)
	copy(out[4:], checksum)
	binary.LittleEndian.PutUint32(out[12:], n.SeqNum)
	copy(out[16:], p)

	n.SeqNum++
	return out
}

func (n *NTLMv2Security) GssDecrypt(s []byte) []byte {
	if len(s) < 16 {
		return nil
	}
	// s[0:4] = version (ignored), s[4:12] = checksum, s[12:16] = seqNum, s[16:] = data
	checksum := s[4:12]
	seqNum := binary.LittleEndian.Uint32(s[12:16])
	data := s[16:]

	p := make([]byte, len(data))
	n.DecryptRC4.XORKeyStream(p, data)

	check := make([]byte, 8)
	n.DecryptRC4.XORKeyStream(check, checksum)

	// HMAC input: seqNum(4) + decrypted(len(p))
	verifyInput := make([]byte, 4+len(p))
	binary.LittleEndian.PutUint32(verifyInput, seqNum)
	copy(verifyInput[4:], p)
	verify := HMAC_MD5(n.VerifyKey, verifyInput)[:8]

	if !bytes.Equal(verify, check) {
		return nil
	}
	return p
}
