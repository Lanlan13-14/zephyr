# Golang Remote Desktop Protocol

grdp is a pure Golang implementation of the Microsoft RDP (Remote Desktop Protocol) protocol client

Forked from [tomatome/grdp](https://github.com/tomatome/grdp)

## How to execute example

Prepare environment variables
(In your environment. You may also need to set GRDP_DOMAIN)
```
export GRDP_USER=user
export GRDP_PASSWORD=password
export GRDP_PORT=3389
export GRDP_HOST=host
export GRDP_WINDOW_SIZE=1280x800
```

### Environment Variables

| Variable              | Description                              | Default            |
|-----------------------|------------------------------------------|--------------------|
| `GRDP_HOST`           | Hostname or IP address of the RDP server | (required)         |
| `GRDP_PORT`           | Port number                              | (required)         |
| `GRDP_USER`           | Username                                 | (empty)            |
| `GRDP_PASSWORD`       | Password                                 | (empty)            |
| `GRDP_DOMAIN`         | Domain                                   | (empty)            |
| `GRDP_WINDOW_SIZE`    | Window size in `WxH` format              | `1280x800`         |
| `GRDP_KEYBOARD_TYPE`  | Keyboard type (see values below)         | `IBM_101_102_KEYS` |
| `GRDP_KEYBOARD_LAYOUT`| Keyboard layout (see values below)       | `US`               |
| `GRDP_AUDIO_DELAY_MS` | Shift audio output later by N ms (use when audio leads video) | `0` |
| `GRDP_VIDEO_DELAY_MS` | Shift video display later by N ms (use when video leads audio) | `0` |

#### `GRDP_KEYBOARD_TYPE` values

| Value              | Description                            |
|--------------------|----------------------------------------|
| `IBM_PC_XT_83_KEY` | IBM PC/XT 83-key keyboard              |
| `OLIVETTI`         | Olivetti keyboard                      |
| `IBM_PC_AT_84_KEY` | IBM PC/AT 84-key keyboard              |
| `IBM_101_102_KEYS` | IBM 101/102-key keyboard (most common) |
| `NOKIA_1050`       | Nokia 1050 keyboard                    |
| `NOKIA_9140`       | Nokia 9140 keyboard                    |
| `JAPANESE`         | Japanese keyboard                      |

#### `GRDP_KEYBOARD_LAYOUT` values

| Value                 | Language / Region       |
|-----------------------|-------------------------|
| `ARABIC`              | Arabic                  |
| `BULGARIAN`           | Bulgarian               |
| `CHINESE_US_KEYBOARD` | Chinese (US keyboard)   |
| `CZECH`               | Czech                   |
| `DANISH`              | Danish                  |
| `GERMAN`              | German                  |
| `GREEK`               | Greek                   |
| `US`                  | English (United States) |
| `SPANISH`             | Spanish                 |
| `FINNISH`             | Finnish                 |
| `FRENCH`              | French                  |
| `HEBREW`              | Hebrew                  |
| `HUNGARIAN`           | Hungarian               |
| `ICELANDIC`           | Icelandic               |
| `ITALIAN`             | Italian                 |
| `JAPANESE`            | Japanese                |
| `KOREAN`              | Korean                  |
| `DUTCH`               | Dutch                   |
| `NORWEGIAN`           | Norwegian               |

Clone and execute example
```
git clone https://github.com/nakagami/grdp
cd grdp
go run ./example/
```

### AVC/H.264 Hardware Accelerated Codec (Optional)

By default, grdp is pure Go and AVC (H.264) codecs are disabled.
To enable hardware-accelerated H.264 decoding, build with the `h264` tag and FFmpeg (≥ 3.4) development libraries:

```
# macOS
brew install ffmpeg

# Debian/Ubuntu
sudo apt install libavcodec-dev libavutil-dev libswscale-dev pkg-config

# Build and run with AVC support
go run -tags h264 ./example/
```

When built with `-tags h264`, the client advertises RDPGFX v10/v8.1 capabilities
and supports AVC420/AVC444 codecs. Hardware acceleration (VideoToolbox on macOS,
VAAPI on Linux) is automatically used when available, with a software fallback.

> **Note:** Always pass `./example/` (package path) rather than a single file such as
> `example/gxui.go`. Specifying a single file omits the other source files in the
> package (`aac_darwin.go`, `h264_ffmpeg.go`, etc.) and results in build errors.

### AAC Audio Hardware Decoding (macOS)

On macOS, the example automatically decodes AAC audio streams using
[AudioToolbox](https://developer.apple.com/documentation/audiotoolbox)
(hardware-accelerated on Apple Silicon and Intel iGPU) when the server offers
AAC (`WAVE_FORMAT_AAC`, tag `0x00FF`).  No extra build flags are required;
AudioToolbox is part of the macOS SDK.

On other platforms the example falls back to PCM audio.

This example uses gxui.
Since gxui is no longer being updated, I hope to have some kind of cross-platform GUI example.

## Related Projects

- https://github.com/nakagami/grdpsdl2
- https://github.com/nakagami/grdpwasm

## Take ideas from

* [rdpy](https://github.com/citronneur/rdpy)
* [node-rdpjs](https://github.com/citronneur/node-rdpjs)
* [gordp](https://github.com/Madnikulin50/gordp)
* [ncrack_rdp](https://github.com/nmap/ncrack/blob/master/modules/ncrack_rdp.cc)
* [webRDP](https://github.com/Chorder/webRDP)
