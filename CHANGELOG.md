# Changelog

All notable changes to ElyApiClient are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-22

First release.

### Added

- **Request builder** for `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` and `OPTIONS`, with
  multi-tab documents, dirty tracking and per-request timeout/redirect/TLS overrides.
- **Response viewer** with Pretty, Raw, Preview, Headers, Cookies, Tests and Timing views;
  categorised errors (DNS, TLS, timeout, refused, blocked address, oversize) with actionable hints.
- **Collections and folders** with nesting, rename, duplicate, move, delete-with-confirmation,
  search, collection-level variables, headers and inherited test scripts.
- **Environments** with variables, secret flags backed by the OS keychain, and `Ctrl+Alt+V` switching.
- **Authentication**: none, bearer, basic, API key (header or query) and OAuth 2.0 client credentials,
  with credentials stored in `SecretStorage` and masked everywhere else.
- **Automated testing**: `node:vm` sandbox with a Postman-compatible `pm` API (`pm.test`,
  `pm.expect` chai subset, `pm.response`, `pm.request`, `pm.environment`, variables, cookies,
  console capture), pre-request scripts, execution timeout and memory cap.
- **WebSocket client** with connect/send/receive log, timestamps and a bounded message buffer.
- **Import/export**: Postman v2.1, OpenAPI 3 (JSON and YAML) and cURL in; sanitised JSON out.
  Imported scripts are never executed automatically.
- **History** with configurable retention, sensitive header redaction and one-click resend.
- **Settings UI** covering general, appearance and history/script options, backed by `elyApiClient.*`
  settings.
- **UI harness** (`npm run harness`) that runs the real client core in Node against an in-process
  HTTP + WebSocket mock API, used for UI development and to generate documentation screenshots.
- **Test suite**: vitest unit tests (URL validation, variable resolution, sanitisation, assertions)
  and integration tests driving the real message protocol against the mock API.

### Security

- Request targets restricted to `http`/`https`; optional private-network blocking with a
  trusted-host allow-list and DNS re-resolution before connecting.
- Header injection (CRLF/NUL) rejected; header names and lengths validated.
- Response bodies rendered via `textContent`; HTML preview sanitised; no `innerHTML` with API data.
- Every inbound webview message schema-validated; remote content cannot escalate to the extension host.
- TLS verification enabled by default; credentials never logged, exported or sent back to the webview.
