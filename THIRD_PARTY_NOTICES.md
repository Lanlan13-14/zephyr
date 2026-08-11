# Third-Party Notices

Zephyr-SSH uses and integrates with third-party open-source software and external services. Each third-party project remains licensed under its own license. This file is provided for attribution and license notice purposes only; it does not replace the license terms of the individual projects.

The Zephyr-SSH project itself is licensed under the GNU General Public License v3.0. See [LICENSE](./LICENSE) for details.

## Runtime and server-side dependencies

| Project | License | Purpose | Link |
|---|---|---|---|
| Express | MIT | Web application framework | <https://expressjs.com/> |
| ws | MIT | WebSocket server/client support | <https://github.com/websockets/ws> |
| ssh2 | MIT | SSH/SFTP client functionality | <https://github.com/mscdex/ssh2> |
| better-sqlite3 | MIT | SQLite database access | <https://github.com/WiseLibs/better-sqlite3> |
| @noble/post-quantum | MIT | ML-KEM-768 post-quantum key encapsulation for encrypted data fields | <https://github.com/paulmillr/noble-post-quantum> |
| SimpleWebAuthn | MIT | Passkey/WebAuthn server support | <https://simplewebauthn.dev/> |
| nodemailer | MIT | Email delivery support | <https://nodemailer.com/> |
| otplib | MIT | TOTP/OTP generation and verification | <https://github.com/yeojz/otplib> |
| qrcode | MIT | QR code generation | <https://github.com/soldair/node-qrcode> |
| multer | MIT | HTTP multipart/form-data handling | <https://github.com/expressjs/multer> |
| archiver | MIT | Archive creation | <https://github.com/archiverjs/node-archiver> |
| unzipper | MIT | ZIP archive extraction | <https://github.com/ZJONSSON/node-unzipper> |
| ipaddr.js | MIT | IP address parsing and validation | <https://github.com/whitequark/ipaddr.js> |
| sharp | Apache-2.0 | Image processing and preview conversion | <https://sharp.pixelplumbing.com/> |
| FreeRDP | Apache-2.0 | RDP client runtime used by Zephyr's native RDP pipeline | <https://www.freerdp.com/> |
| OpenSSL 3.6.3 / OpenSSL-Package | Apache-2.0 | FIPS 203 ML-KEM-768 for iOS/macOS. SwiftPM manifest commit `0b0cc7392a4ff6a798c9ed8f4981f1c1bbcb4722`; XCFramework SHA-256 `6c4b064d12b8de2ae77ac59fbcbbd1c20b4fecfb7fc50b8ab326347c52ecbf0c` | <https://www.openssl.org/> / <https://github.com/krzyzanowskim/OpenSSL-Package> |
| noVNC | MPL-2.0 | Browser-side VNC client | <https://novnc.com/> |

## Editor and frontend dependencies

| Project | License | Purpose | Link |
|---|---|---|---|
| CodeMirror | MIT | Browser-based code editor | <https://codemirror.net/> |
| Lezer | MIT | Parser system used by CodeMirror | <https://lezer.codemirror.net/> |
| @uiw/codemirror-theme-github | MIT | GitHub-style CodeMirror themes | <https://github.com/uiwjs/react-codemirror> |
| @wterm/dom (vendored fork under `wterm/packages/@wterm/dom`) | MIT | Terminal DOM renderer, input, viewport shell | <https://github.com/vercel-labs/wterm> / <https://wterm.dev/> |
| xterm.js / @xterm/headless (vendored source under `xterm/`, runtime bundle under `public/vendor/wterm-fork/core/`) | MIT | VT parser, buffer, reflow (headless core); DOM paint stays wterm | <https://github.com/xtermjs/xterm.js> | 
| Prettier | MIT | Code formatting | <https://prettier.io/> |
| Viewer.js | MIT | Image preview viewer | <https://github.com/fengyuanchen/viewerjs> |
| Chart.js | MIT | Charts and statistics UI | <https://www.chartjs.org/> |
| vscode-json-languageservice | MIT | JSON language features | <https://github.com/microsoft/vscode-json-languageservice> |
| vscode-languageserver-protocol | MIT | Language Server Protocol types and helpers | <https://github.com/microsoft/vscode-languageserver-node> |
| vscode-languageserver-textdocument | MIT | LSP text document helper | <https://github.com/microsoft/vscode-languageserver-node> |
| vscode-ws-jsonrpc | MIT | JSON-RPC over WebSocket support | <https://github.com/TypeFox/vscode-ws-jsonrpc> |
| yaml-language-server | MIT | YAML language server features | <https://github.com/redhat-developer/yaml-language-server> |
| esbuild | MIT | Editor bundle build tool | <https://esbuild.github.io/> |

## External verification and network services

Depending on configuration, Zephyr-SSH may load or call third-party verification or network services. These services are not part of Zephyr-SSH and are governed by their own terms and policies.

| Service | Purpose | Link |
|---|---|---|
| Cloudflare Turnstile | CAPTCHA / bot verification | <https://www.cloudflare.com/products/turnstile/> |
| hCaptcha | CAPTCHA / bot verification | <https://www.hcaptcha.com/> |
| Google reCAPTCHA | CAPTCHA / bot verification | <https://www.google.com/recaptcha/> |
| Tencent Captcha | CAPTCHA / bot verification | <https://007.qq.com/> |
| Alibaba Cloud Captcha | CAPTCHA / bot verification | <https://help.aliyun.com/> |
| SchemaStore | JSON schema catalog lookup | <https://www.schemastore.org/> |
| api.ipify.org / api64.ipify.org | Public IP address lookup | <https://www.ipify.org/> |
| ifconfig.me / ifconfig.co | Public IP address lookup fallback | <https://ifconfig.me/> |

## Notes for redistributors

If you redistribute Zephyr-SSH, especially as a Docker image, binary package, modified source distribution, or hosted service package, make sure you comply with the licenses of Zephyr-SSH and all included third-party components.

This notice is intended to be accurate and helpful, but it may not be exhaustive. Dependency versions and transitive dependencies are defined by `package.json`, `package-lock.json`, the Dockerfile, and the corresponding upstream projects.
