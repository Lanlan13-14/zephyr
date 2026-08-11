/*
 * zephyr_rdp_test.c — links against the real libfreerdp and asserts the shim's
 * behaviour, rather than asserting that a reimplementation agrees with itself.
 *
 * What each group proves:
 *   UTF        — the hand-rolled converters (written because WinPR 3 removed
 *                ConvertToUnicode) round-trip real payloads and *reject*
 *                malformed input instead of silently truncating.
 *   DRIVE      — folder mapping actually lands in FreeRDP's RDPDR device
 *                collection with the right type/name/path. This is the check a
 *                live server cannot give us: a server proves the channel opened,
 *                only this proves the settings were assembled correctly.
 *   SETTINGS   — each UI toggle maps to the FreeRDP setting it claims to, in
 *                both directions (on *and* off), so "not set" can never be
 *                mistaken for "set false".
 *
 * Build: see run-ctests.sh
 */
#include "zephyr_rdp.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>
#ifdef _WIN32
#include <direct.h>
#include <io.h>
#define mkdir(path, mode) _mkdir(path)
#define access _access
#define rmdir _rmdir
#ifndef F_OK
#define F_OK 0
#endif
#else
#include <unistd.h>
#endif

#ifdef ZEPHYR_RDP_TESTING
#define ZEPHYR_RDP_TEST_FAIL_HOST    1
#define ZEPHYR_RDP_TEST_FAIL_CONTEXT 9
#define ZEPHYR_RDP_TEST_FAIL_CONFIG 10
#define ZEPHYR_RDP_TEST_FAIL_READY  11
int32_t zephyr_rdp_test_new_failure_cleanup(const zephyr_rdp_config* cfg,
                                            int32_t failpoint);
int32_t zephyr_rdp_test_password_wipe_cleanup(const zephyr_rdp_config* cfg,
                                              int32_t failpoint);
#endif

/* Fixture roots. These are created by the test itself rather than assumed to
 * exist: the first run of this suite failed purely because the paths were
 * absent, which is also how the production defect was found. A test that
 * depends on a hand-made directory reports the environment, not the code. */
#ifdef _WIN32
#define FIX_ASCII "zephyr-rdp-fixture-share"
#define FIX_CJK   "zephyr-rdp-fixture-unicode-name"
#define FIX_FILE  "zephyr-rdp-fixture-notadir"
#define FIX_ABSENT "zephyr-rdp-fixture-does-not-exist-9d3f1a"
#else
#define FIX_ASCII "/tmp/zephyr-rdp-fixture-share"
#define FIX_CJK   "/tmp/zephyr-rdp-fixture-\xe6\x96\x87\xe4\xbb\xb6\xe5\xa4\xb9"
#define FIX_FILE  "/tmp/zephyr-rdp-fixture-notadir"
#define FIX_ABSENT "/tmp/zephyr-rdp-fixture-does-not-exist-9d3f1a"
#endif

static int failures = 0;
static int checks = 0;

static void ok(int cond, const char* what) {
    checks++;
    if (!cond) {
        failures++;
        printf("  FAIL %s\n", what);
    } else {
        printf("  ok   %s\n", what);
    }
}

static void eq_int(long got, long want, const char* what) {
    checks++;
    if (got != want) {
        failures++;
        printf("  FAIL %s (got %ld want %ld)\n", what, got, want);
    } else {
        printf("  ok   %s (%ld)\n", what, got);
    }
}

static void eq_str(const char* got, const char* want, const char* what) {
    checks++;
    if (!got || strcmp(got, want) != 0) {
        failures++;
        printf("  FAIL %s (got \"%s\" want \"%s\")\n", what, got ? got : "(null)", want);
    } else {
        printf("  ok   %s (\"%s\")\n", what, got);
    }
}

/* Baseline config used by the settings/drive probes. Deliberately not all
 * zeroes: a config of zeroes would pass a test that merely forgot to set
 * anything. */
static zephyr_rdp_config base_config(void) {
    zephyr_rdp_config c;
    memset(&c, 0, sizeof(c));
    c.host = "10.0.0.5";
    c.port = 3389;
    c.username = "tester";
    c.password = "secret";
    c.domain = "";
    c.width = 1920;
    c.height = 1080;
    c.color_depth = 32;
    c.security = ZEPHYR_RDP_SEC_AUTO;
    c.audio_mode = ZEPHYR_RDP_AUDIO_LOCAL;
    return c;
}

static void test_utf(void) {
    printf("UTF conversion\n");

    /* Round-trip: ASCII, CJK, emoji (surrogate pair), and a mix. Emoji is the
     * case a naive UCS-2 converter silently mangles. */
    const char* samples[] = {
        "hello",
        "\xe6\x96\x87\xe4\xbb\xb6\xe5\xa4\xb9\xe6\x98\xa0\xe5\xb0\x84", /* 文件夹映射 */
        "\xf0\x9f\x93\x81",                                             /* 📁 U+1F4C1 */
        "A\xe4\xb8\xad\xf0\x9f\x93\x81Z",
        "",
    };
    for (size_t i = 0; i < sizeof(samples) / sizeof(samples[0]); i++) {
        char out[256];
        memset(out, 0, sizeof(out));
        int32_t rc = zephyr_rdp_utf_roundtrip(samples[i], out, sizeof(out));
        ok(rc >= 0, "roundtrip returns success");
        eq_str(out, samples[i], "roundtrip preserves bytes");
    }

    /* Surrogate pair must become exactly 2 UTF-16 code units + NUL = 3. */
    eq_int(zephyr_rdp_test_utf8_to_utf16le("\xf0\x9f\x93\x81", NULL, 0), 3,
           "U+1F4C1 measures 3 units (surrogate pair + NUL)");
    eq_int(zephyr_rdp_test_utf8_to_utf16le("ab", NULL, 0), 3, "\"ab\" measures 3 units");

    /* Malformed input is rejected, not repaired. Each of these would produce
     * plausible-looking wrong text under a lenient converter. */
    eq_int(zephyr_rdp_test_utf8_to_utf16le("\xc0\x80", NULL, 0), -1,
           "overlong 2-byte NUL rejected");
    eq_int(zephyr_rdp_test_utf8_to_utf16le("\xe0\x80\x80", NULL, 0), -1,
           "overlong 3-byte rejected");
    eq_int(zephyr_rdp_test_utf8_to_utf16le("\xed\xa0\x80", NULL, 0), -1,
           "lone surrogate D800 rejected");
    eq_int(zephyr_rdp_test_utf8_to_utf16le("\xf5\x80\x80\x80", NULL, 0), -1,
           "codepoint > U+10FFFF rejected");
    eq_int(zephyr_rdp_test_utf8_to_utf16le("\xe6\x96", NULL, 0), -1,
           "truncated 3-byte sequence rejected");
    eq_int(zephyr_rdp_test_utf8_to_utf16le("\x80", NULL, 0), -1,
           "bare continuation byte rejected");

    /* Output-buffer bound is honoured rather than overflowing. */
    {
        uint16_t tiny[1];
        eq_int(zephyr_rdp_test_utf8_to_utf16le("ab", tiny, 1), -1,
               "undersized output buffer refused");
    }

    /* UTF-16 → UTF-8 rejects a lone high surrogate with no pair. */
    {
        uint16_t lone[2] = { 0xD83D, 0x0000 };
        char out[16];
        eq_int(zephyr_rdp_test_utf16le_to_utf8(lone, 2, out, sizeof(out)), -1,
               "lone high surrogate rejected on the way back");
    }
    /* And accepts a proper pair, producing the 4-byte UTF-8 form. */
    {
        uint16_t pair[3] = { 0xD83D, 0xDCC1, 0x0000 };
        char out[16];
        memset(out, 0, sizeof(out));
        long n = zephyr_rdp_test_utf16le_to_utf8(pair, 3, out, sizeof(out));
        eq_int(n, 4, "surrogate pair yields 4 UTF-8 bytes");
        eq_str(out, "\xf0\x9f\x93\x81", "surrogate pair decodes to U+1F4C1");
    }
}

static void test_clipboard_payload_bounds(void) {
    printf("\nClipboard response bounds\n");

    {
        const uint8_t valid[] = { 'A', 0, 0x3d, 0xd8, 0xc1, 0xdc, 0, 0 };
        eq_int(zephyr_rdp_test_clipboard_payload(valid, sizeof(valid)), 1,
               "ASCII plus surrogate pair accepted");
    }
    {
        const uint8_t odd[] = { 'A', 0, 0 };
        eq_int(zephyr_rdp_test_clipboard_payload(odd, sizeof(odd)), 0,
               "odd dataLen rejected");
    }
    {
        const uint8_t no_nul[] = { 'A', 0, 'B', 0 };
        eq_int(zephyr_rdp_test_clipboard_payload(no_nul, sizeof(no_nul)), 0,
               "payload without final UTF-16 NUL rejected");
    }
    {
        const uint8_t embedded_nul[] = { 'A', 0, 0, 0, 'B', 0, 0, 0 };
        eq_int(zephyr_rdp_test_clipboard_payload(embedded_nul,
                                                sizeof(embedded_nul)),
               0, "embedded NUL and ignored suffix rejected");
    }
    {
        const uint8_t lone_high[] = { 0x3d, 0xd8, 0, 0 };
        const uint8_t lone_low[] = { 0xc1, 0xdc, 0, 0 };
        eq_int(zephyr_rdp_test_clipboard_payload(lone_high, sizeof(lone_high)), 0,
               "lone high surrogate rejected");
        eq_int(zephyr_rdp_test_clipboard_payload(lone_low, sizeof(lone_low)), 0,
               "lone low surrogate rejected");
    }
    {
        uint8_t tiny[] = { 0, 0 };
        eq_int(zephyr_rdp_test_clipboard_payload(NULL, sizeof(tiny)), 0,
               "NULL data rejected");
        eq_int(zephyr_rdp_test_clipboard_payload(
                   tiny, (size_t)ZEPHYR_RDP_MAX_CLIPBOARD_UTF16_BYTES + 2u),
               0, "one UTF-16 unit over the limit rejected before reading");
        eq_int(zephyr_rdp_test_clipboard_payload(tiny, SIZE_MAX), 0,
               "SIZE_MAX rejected without multiply/add overflow");
    }
    {
        const size_t bytes = (size_t)ZEPHYR_RDP_MAX_CLIPBOARD_UTF16_BYTES;
        uint8_t* boundary = (uint8_t*)calloc(bytes, 1);
        ok(boundary != NULL, "exact-limit fixture allocated");
        if (boundary) {
            for (size_t offset = 0; offset < bytes - 2u; offset += 2u)
                boundary[offset] = 'x';
            eq_int(zephyr_rdp_test_clipboard_payload(boundary, bytes), 1,
                   "exact 4 MiB UTF-16 payload accepted");
            free(boundary);
        }
    }
}

static void test_drive(void) {
    printf("\nRDPDR folder mapping\n");

    const int32_t RDPDR_DTYP_FILESYSTEM = 8; /* MS-RDPEFS */

    /* 1. A configured folder produces exactly one filesystem device carrying
     *    the requested name and path. */
    {
        zephyr_rdp_config c = base_config();
        c.drive_name = "ZephyrShare";
        c.drive_path = FIX_ASCII;
        char name[128] = { 0 }, path[512] = { 0 };
        int32_t type = -1;
        int32_t count = zephyr_rdp_probe_drive(&c, name, sizeof(name), path,
                                               sizeof(path), &type);
        eq_int(count, 1, "one RDPDR device registered");
        eq_str(name, "ZephyrShare", "device name is the configured share name");
        eq_str(path, FIX_ASCII, "device path is the mapped folder");
        eq_int(type, RDPDR_DTYP_FILESYSTEM, "device type is FILESYSTEM (8)");
    }

    /* 2. No folder configured → no device. This is the half of the contract that
     *    catches an implementation that always maps something. */
    {
        zephyr_rdp_config c = base_config();
        c.drive_name = NULL;
        c.drive_path = NULL;
        char name[128] = { 0 }, path[512] = { 0 };
        int32_t type = -1;
        int32_t count = zephyr_rdp_probe_drive(&c, name, sizeof(name), path,
                                               sizeof(path), &type);
        eq_int(count, 0, "no device when no folder is configured");
    }

    /* 3. A name without a path (and vice versa) must not half-register. */
    {
        zephyr_rdp_config c = base_config();
        c.drive_name = "Orphan";
        c.drive_path = "";
        char name[128] = { 0 }, path[512] = { 0 };
        int32_t type = -1;
        eq_int(zephyr_rdp_probe_drive(&c, name, sizeof(name), path, sizeof(path), &type),
               0, "name without path registers nothing");
    }
    {
        zephyr_rdp_config c = base_config();
        c.drive_name = "";
        c.drive_path = FIX_ASCII;
        char name[128] = { 0 }, path[512] = { 0 };
        int32_t type = -1;
        eq_int(zephyr_rdp_probe_drive(&c, name, sizeof(name), path, sizeof(path), &type),
               0, "path without name registers nothing");
    }

    /* 4. Unicode share names survive into the device collection: the folder
     *    picker can hand us a Chinese folder name. */
    {
        zephyr_rdp_config c = base_config();
        c.drive_name = "\xe6\x96\x87\xe4\xbb\xb6\xe5\xa4\xb9"; /* 文件夹 */
        c.drive_path = FIX_CJK;
        char name[128] = { 0 }, path[512] = { 0 };
        int32_t type = -1;
        eq_int(zephyr_rdp_probe_drive(&c, name, sizeof(name), path, sizeof(path), &type),
               1, "unicode share name registers");
        eq_str(name, "\xe6\x96\x87\xe4\xbb\xb6\xe5\xa4\xb9", "unicode name preserved");
        eq_str(path, FIX_CJK, "unicode path preserved");
    }
}

static void test_settings(void) {
    printf("\nSettings mapping\n");

    int32_t nla, tls, rdpsec, play, cap, clip, devredir, dynres, gfx;

    /* Audio LOCAL enables playback; REMOTE and OFF both clear it. Testing the
     * false direction is the point: a probe that only checked LOCAL would pass
     * even if the setting were never written. */
    {
        zephyr_rdp_config c = base_config();
        c.audio_mode = ZEPHYR_RDP_AUDIO_LOCAL;
        ok(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap, &clip,
                                     &devredir, &dynres, &gfx) == 0,
           "probe_settings succeeds (audio local)");
        eq_int(play, 1, "AudioPlayback on for audio_mode=LOCAL");
    }
    {
        zephyr_rdp_config c = base_config();
        c.audio_mode = ZEPHYR_RDP_AUDIO_REMOTE;
        zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap, &clip,
                                  &devredir, &dynres, &gfx);
        eq_int(play, 0, "AudioPlayback off for audio_mode=REMOTE");
    }
    {
        zephyr_rdp_config c = base_config();
        c.audio_mode = ZEPHYR_RDP_AUDIO_OFF;
        zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap, &clip,
                                  &devredir, &dynres, &gfx);
        eq_int(play, 0, "AudioPlayback off for audio_mode=OFF");
    }

    /* Microphone / clipboard / dynamic resolution / gfx: both directions. */
    {
        zephyr_rdp_config c = base_config();
        c.microphone = 1;
        c.clipboard = 1;
        c.dynamic_resolution = 1;
        c.gfx = 1;
        zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap, &clip,
                                  &devredir, &dynres, &gfx);
        eq_int(cap, 1, "AudioCapture on when microphone=1");
        eq_int(clip, zephyr_rdp_clipboard_available(),
               "RedirectClipboard follows pre-reassembly hardening availability");
        eq_int(dynres, 1, "DynamicResolutionUpdate on when requested");
        eq_int(gfx, 1, "SupportGraphicsPipeline on when requested");
    }
    {
        zephyr_rdp_config c = base_config();
        c.microphone = 0;
        c.clipboard = 0;
        c.dynamic_resolution = 0;
        c.gfx = 0;
        zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap, &clip,
                                  &devredir, &dynres, &gfx);
        eq_int(cap, 0, "AudioCapture off when microphone=0");
        eq_int(clip, 0, "RedirectClipboard off when clipboard=0");
        eq_int(dynres, 0, "DynamicResolutionUpdate off when not requested");
        eq_int(gfx, 0, "SupportGraphicsPipeline off when not requested");
    }

    /* DeviceRedirection must follow the folder mapping, not be always-on. */
    {
        zephyr_rdp_config c = base_config();
        c.drive_name = "Share";
        c.drive_path = "/tmp";
        zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap, &clip,
                                  &devredir, &dynres, &gfx);
        eq_int(devredir, 1, "DeviceRedirection on when a folder is mapped");
    }
    {
        zephyr_rdp_config c = base_config();
        zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap, &clip,
                                  &devredir, &dynres, &gfx);
        eq_int(devredir, 0, "DeviceRedirection off when no folder is mapped");
    }

    /* AUTO is a compatibility spelling for NLA-only, including when the
     * password is empty. TLS-only must never become a passwordless fallback. */
    {
        zephyr_rdp_config c = base_config();
        c.password = "";
        c.security = ZEPHYR_RDP_SEC_AUTO;
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               0, "passwordless AUTO settings accepted");
        eq_int(nla, 1, "passwordless AUTO: NlaSecurity on");
        eq_int(tls, 0, "passwordless AUTO: TlsSecurity off");
        eq_int(rdpsec, 0, "passwordless AUTO: RdpSecurity off");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 0), 0,
               "passwordless AUTO rejects malicious protocol 0 selection");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 1), 0,
               "passwordless AUTO rejects TLS-only downgrade");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 2), 1,
               "passwordless AUTO accepts NLA");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 8), 1,
               "passwordless AUTO accepts NLA extended");
    }
    {
        zephyr_rdp_config c = base_config();
        c.security = ZEPHYR_RDP_SEC_AUTO;
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               0, "credentialed AUTO settings accepted as NLA");
        eq_int(nla, 1, "credentialed AUTO: NlaSecurity on");
        eq_int(tls, 0, "credentialed AUTO: TlsSecurity off");
        eq_int(rdpsec, 0, "credentialed AUTO: RdpSecurity off");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 0), 0,
               "credentialed AUTO rejects protocol 0");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 1), 0,
               "credentialed AUTO rejects TLS-only downgrade");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 2), 1,
               "credentialed AUTO accepts NLA");
    }

    /* Explicit NLA pins the same negotiation result. */
    {
        zephyr_rdp_config c = base_config();
        c.security = ZEPHYR_RDP_SEC_NLA;
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               0, "NLA settings accepted");
        eq_int(nla, 1, "NLA mode: NlaSecurity on");
        eq_int(tls, 0, "NLA mode: TlsSecurity off");
        eq_int(rdpsec, 0, "NLA mode: RdpSecurity off");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 0), 0,
               "NLA rejects protocol 0");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 1), 0,
               "NLA rejects TLS-only selection");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 2), 1,
               "NLA accepts HYBRID");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 8), 1,
               "NLA accepts HYBRID_EX");
        c.password = "";
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               0, "passwordless explicit NLA settings accepted");
        eq_int(tls, 0, "passwordless explicit NLA keeps TLS-only off");
    }
    /* TLS-only and legacy modes fail regardless of credential presence. */
    {
        zephyr_rdp_config c = base_config();
        c.security = ZEPHYR_RDP_SEC_TLS;
        c.password = "";
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               -1, "TLS-only without password rejected");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 1), 0,
               "TLS-only protocol is never allowed");
        c.password = "secret";
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               -1, "TLS-only with password rejected");
    }

    /* Legacy and unknown modes fail before settings or credentials are used. */
    {
        zephyr_rdp_config c = base_config();
        c.security = ZEPHYR_RDP_SEC_RDP;
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               -1, "legacy RDP with password rejected");
        c.password = "";
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               -1, "legacy RDP without password rejected");
        eq_int(zephyr_rdp_security_protocol_allowed(&c, 0), 0,
               "legacy protocol is never allowed");
    }
    {
        zephyr_rdp_config c = base_config();
        c.security = 99;
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               -1, "unknown security value rejected");
        c.security = -1;
        eq_int(zephyr_rdp_probe_settings(&c, &nla, &tls, &rdpsec, &play, &cap,
                                         &clip, &devredir, &dynres, &gfx),
               -1, "negative security value rejected");
    }
}

/* ── folder-mapping validation ────────────────────────────────────────────── */

static void test_session_lifecycle(void) {
    printf("\nSession construction lifecycle\n");

    zephyr_rdp_config c = base_config();
    c.domain = "example";
    c.drive_name = "Share";
    c.drive_path = FIX_ASCII;

#ifdef ZEPHYR_RDP_TESTING
    for (int32_t failpoint = ZEPHYR_RDP_TEST_FAIL_HOST;
         failpoint <= ZEPHYR_RDP_TEST_FAIL_READY; failpoint++) {
        char label[96];
        snprintf(label, sizeof(label),
                 "construction failpoint %d releases every owned resource",
                 (int)failpoint);
        eq_int(zephyr_rdp_test_new_failure_cleanup(&c, failpoint), 1, label);
    }

    eq_int(zephyr_rdp_test_password_wipe_cleanup(
               &c, ZEPHYR_RDP_TEST_FAIL_CONTEXT),
           1, "pre-context failure zeroes the owned password before free");
    eq_int(zephyr_rdp_test_password_wipe_cleanup(
               &c, ZEPHYR_RDP_TEST_FAIL_READY),
           3, "post-config failure zeroes owned and FreeRDP password copies");
    eq_int(zephyr_rdp_test_password_wipe_cleanup(&c, 0), 3,
           "normal teardown zeroes owned and FreeRDP password copies");
#else
    ok(0, "lifecycle failure injection was compiled into the C test binary");
#endif

    /* Normal teardown also drains queued owned payloads. Repetition makes an
     * accidental double-close/double-free deterministic under the C runtime. */
    c.drive_name = NULL;
    c.drive_path = NULL;
    for (int i = 0; i < 8; i++) {
        zephyr_rdp_session* s = zephyr_rdp_new(&c, NULL, NULL, NULL);
        ok(s != NULL, "session allocates for lifecycle teardown");
        if (!s) continue;
        zephyr_rdp_set_clipboard(s, "queued clipboard payload");
        zephyr_rdp_free(s);
    }

    zephyr_rdp_free(NULL);
    eq_int(zephyr_rdp_new(NULL, NULL, NULL, NULL) == NULL, 1,
           "NULL config fails without allocating a session");

    c.security = ZEPHYR_RDP_SEC_TLS;
    c.password = "";
    eq_int(zephyr_rdp_new(&c, NULL, NULL, NULL) == NULL, 1,
           "TLS-only config fails before allocating native resources");
    c.security = ZEPHYR_RDP_SEC_RDP;
    eq_int(zephyr_rdp_new(&c, NULL, NULL, NULL) == NULL, 1,
           "legacy RDP config fails before allocating native resources");
}

static void test_validate(void) {
    printf("\nFolder-mapping validation\n");

    eq_int(zephyr_rdp_validate_drive("Share", FIX_ASCII), ZEPHYR_RDP_DRIVE_OK,
           "existing directory accepted");
    eq_int(zephyr_rdp_validate_drive("\xe6\x96\x87\xe4\xbb\xb6\xe5\xa4\xb9", FIX_CJK),
           ZEPHYR_RDP_DRIVE_OK, "CJK name and CJK path accepted");

    eq_int(zephyr_rdp_validate_drive("", FIX_ASCII), ZEPHYR_RDP_DRIVE_NO_NAME,
           "empty share name reported as NO_NAME");
    eq_int(zephyr_rdp_validate_drive(NULL, FIX_ASCII), ZEPHYR_RDP_DRIVE_NO_NAME,
           "NULL share name reported as NO_NAME");
    eq_int(zephyr_rdp_validate_drive("Share", ""), ZEPHYR_RDP_DRIVE_NO_PATH,
           "empty path reported as NO_PATH");
    eq_int(zephyr_rdp_validate_drive("Share", NULL), ZEPHYR_RDP_DRIVE_NO_PATH,
           "NULL path reported as NO_PATH");

    /* The exact production case: the user picked a folder, then it was deleted
     * or the external disk was unmounted. */
    eq_int(zephyr_rdp_validate_drive("Share", FIX_ABSENT),
           ZEPHYR_RDP_DRIVE_NOT_FOUND, "absent path reported as NOT_FOUND");
    eq_int(zephyr_rdp_validate_drive("Share", FIX_FILE), ZEPHYR_RDP_DRIVE_NOT_DIR,
           "regular file reported as NOT_DIR");

    /* A separator in the share name would be interpreted by the remote
     * Explorer rather than displayed. */
    eq_int(zephyr_rdp_validate_drive("bad/name", FIX_ASCII),
           ZEPHYR_RDP_DRIVE_BAD_NAME, "share name with '/' refused");
    eq_int(zephyr_rdp_validate_drive("bad\\name", FIX_ASCII),
           ZEPHYR_RDP_DRIVE_BAD_NAME, "share name with '\\' refused");
    eq_int(zephyr_rdp_validate_drive("C:", FIX_ASCII), ZEPHYR_RDP_DRIVE_BAD_NAME,
           "share name with ':' refused");

    /* Invalid UTF-8 in the name: a lone continuation byte. */
    eq_int(zephyr_rdp_validate_drive("\x80\x80", FIX_ASCII),
           ZEPHYR_RDP_DRIVE_BAD_NAME, "invalid UTF-8 share name refused");

    /*
     * Reproduce the underlying FreeRDP behaviour that makes validation
     * necessary at all. This is the reverse-verification: if a future FreeRDP
     * stopped stat()ing the path, this assertion fails and tells us the
     * pre-check's rationale changed — rather than leaving a comment claiming
     * something no longer true.
     */
    {
        zephyr_rdp_config c = base_config();
        c.drive_name = "Share";
        c.drive_path = FIX_ABSENT;
        char name[128] = { 0 }, path[512] = { 0 };
        int32_t type = -1;
        int32_t count = zephyr_rdp_probe_drive(&c, name, sizeof(name), path,
                                               sizeof(path), &type);
        /* FreeRDP 2 rejects settings assembly (-1); FreeRDP 3 accepts the
         * channel arguments but omits the invalid device (0). Neither produces
         * a mapped drive, and neither reports a useful reason to the user —
         * which is why zephyr_rdp_validate_drive runs before either version. */
        int32_t expected = zephyr_rdp_freerdp_major() >= 3 ? 0 : -1;
        eq_int(count, expected,
               "FreeRDP does not register a non-existent drive path");
    }

    /* And the same config with an existing path succeeds — proving the absent
     * path was the only variable. */
    {
        zephyr_rdp_config c = base_config();
        c.drive_name = "Share";
        c.drive_path = FIX_ASCII;
        char name[128] = { 0 }, path[512] = { 0 };
        int32_t type = -1;
        eq_int(zephyr_rdp_probe_drive(&c, name, sizeof(name), path, sizeof(path),
                                      &type),
               1, "same config with an existing path registers the device");
    }
}

/* Create the fixtures this suite needs. Returns 0 on success. */
static int make_fixtures(void) {
    if (mkdir(FIX_ASCII, 0700) != 0 && access(FIX_ASCII, F_OK) != 0) return -1;
    if (mkdir(FIX_CJK, 0700) != 0 && access(FIX_CJK, F_OK) != 0) return -1;
    FILE* f = fopen(FIX_FILE, "wb");
    if (!f) return -1;
    fputs("not a directory\n", f);
    fclose(f);
    /* Make sure the "absent" fixture really is absent, even if a previous run
     * left something behind. */
    remove(FIX_ABSENT);
    rmdir(FIX_ABSENT);
    if (access(FIX_ABSENT, F_OK) == 0) return -1;
    return 0;
}

static void remove_fixtures(void) {
    remove(FIX_FILE);
    rmdir(FIX_ASCII);
    rmdir(FIX_CJK);
    remove(FIX_ABSENT);
    rmdir(FIX_ABSENT);
}

int main(void) {
    printf("zephyr-one-rdp shim tests (FreeRDP major %d)\n\n",
           (int)zephyr_rdp_freerdp_major());
    if (make_fixtures() != 0) {
        printf("FATAL: could not create test fixtures under /tmp\n");
        remove_fixtures();
        return 2;
    }
    test_utf();
    test_clipboard_payload_bounds();
    test_drive();
    test_validate();
    test_settings();
    test_session_lifecycle();
    printf("\n%d checks, %d failures\n", checks, failures);
    remove_fixtures();
    return failures == 0 ? 0 : 1;
}
