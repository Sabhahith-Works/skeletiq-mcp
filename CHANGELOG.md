# Changelog

Notable changes to `@skeletiq/mcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

npm releases are immutable, so nothing published is ever edited in place — a correction is always a
new version.

## [Unreleased]

Nothing yet.

## [0.1.1] — 2026-09-10

Everything the SkeletIQ API sends about a design now reaches the agent reading it. `0.1.0` mirrored
the API's response shapes by hand and left three fields unnamed, and because those shapes accept
unknown keys on purpose — so a published client keeps working against a newer server — the missing
fields arrived, parsed, and were discarded without an error anywhere.

### Fixed

- **`get_design` returns the design's own reasoning.** A design records why it is shaped the way it
  is, and the server keeps that in two lists: plain statements, and the same statements carrying the
  requirements behind them. Only the first was read, and designs written today usually populate only
  the second — so an agent asking why an architecture looked like that was told nothing, and was free
  to undo a settled decision without knowing it had been taken. Both lists are read now, deduped, in
  `overview` and `component`.
- **`get_design(mode: "readiness")` says what a release would carry.** The app prints that list
  beside its Release button under the heading "It will carry:". An agent asking the same question
  about the same version got silence. Same list, same heading.
- **`get_design(mode: "gaps")` keeps the answers a regeneration stranded.** A question is identified
  by a hash of its own wording, so re-generating a design re-words it and leaves the answer that
  settled it filed against wording nobody will see again. The server reports those precisely so they
  are not lost; they were being dropped here.
- **The scope table says what a token actually needs.** `report` alone cannot run `check_drift` —
  the tool looks the project and the version up through `read` first, so a `report`-only token is
  refused. And `generate` does not always spend credits: `critique_architecture` is under that scope
  and is deterministic and free.

### Added

- The overview now prints the design's decisions and trade-offs, which it previously returned in the
  structured payload and left out of the text a model is actually shown.
- A contract test. The API generates a statement of what it sends, this package ships it, and the
  suite fails when a field in it is neither mirrored nor written down with a reason. It is why the
  three fixes above are the last of their kind to be found by accident.

### Provenance

npm records the commit each version was published from. Splitting this repository's history at that
commit yields exactly the tree tagged `v0.1.1` in the public mirror — so the published package can be
matched to its source byte for byte, not merely by date.

## [0.1.0] — 2026-09-04

First published release.

- Six tools over stdio: `list_projects`, `get_design`, `generate_architecture`,
  `get_generation_status`, `check_drift` and `critique_architecture`.
- Configured by two environment variables: `SKELETIQ_API_KEY` (required, a SkeletIQ personal token)
  and `SKELETIQ_API_URL` (optional, for self-hosted installs).
- Requires Node 20 or newer.
