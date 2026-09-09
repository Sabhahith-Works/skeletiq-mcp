# Changelog

Notable changes to `@skeletiq/mcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

npm releases are immutable, so nothing published is ever edited in place — a correction is always a
new version.

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-09-04

First published release.

- Six tools over stdio: `list_projects`, `get_design`, `generate_architecture`,
  `get_generation_status`, `check_drift` and `critique_architecture`.
- Configured by two environment variables: `SKELETIQ_API_KEY` (required, a SkeletIQ personal token)
  and `SKELETIQ_API_URL` (optional, for self-hosted installs).
- Requires Node 20 or newer.
