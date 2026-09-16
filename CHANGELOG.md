# Changelog

Notable changes to `@skeletiq/mcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

npm releases are immutable, so nothing published is ever edited in place — a correction is always a
new version.

## [Unreleased]

### Added

- **`get_design` reports the requirements a design was built from, and what became of each one.** A
  design records what it was asked to satisfy as `R1…Rn`, and those ids appear inside the design
  itself — on components, and on the decisions that carry the requirements behind them. There was
  nowhere to resolve them: an agent reading `requirement_ids: ["R12"]` held an id and no text, so
  the one thing a design says about what it is *for* was the one thing it could not read. `overview`
  now lists every requirement in its own wording, and `component` lists the ones the design cites
  that component for.

  Each row carries a status, and none of them is "met". `unmet` means the verifier judged the design
  does not satisfy the requirement; `uncited` that nothing in the design claims to address it;
  `unchecked` that something cites it and the verifier did not check it; `cited` that it is cited
  and no gap was found — which is not the same as proven. That last one is the strongest claim the
  product can make, and an agent told a requirement is met stops looking at it. `unmet` and
  `uncited` are listed first for the same reason: they are the two that ask for work. Where a design
  records no citations at all, or the verifier checked only part of the set, the answer says so,
  rather than letting a status be read as a finding it is not.

  Which components a requirement is cited by is the server's answer, computed from the saved design.
  A component's own `requirement_ids` are deliberately not re-read here: a second derivation of the
  same relationship is free to disagree with the first, and then two readers of one version report
  different coverage.

  The field is optional and nullable. A version carrying no requirements analysis — a template, a
  reverse-engineered design, anything from before the analysis existed — prints nothing about
  requirements rather than "0 requirements", and a server that does not send the field at all is
  read exactly as it was before.

- **The ledger is named on the wire, not merely rendered.** `ArchitectureSchema` gained an optional,
  nullable `requirement_ledger`, described by three new schemas in `src/wire/schemas.ts`:
  `RequirementLedgerSchema`, `RequirementLedgerRowSchema` and `RequirementLedgerCountsSchema`. Naming
  a field is what makes it survive — the design payload is rebuilt from named keys, so a field this
  package does not name is dropped without a trace, which is how `grounded_decisions` went missing
  in `0.1.0`. A row's `status` is read as a string rather than as the four words this version
  knows, so a status added server-side arrives intact instead of being refused at the door.

## [0.1.2] — 2026-09-16

### Changed

- **`generate_architecture` now says what happens to a compliance regime SkeletIQ does not check.**
  `constraints.compliance` described itself as `e.g. HIPAA, SOC2, PCI-DSS, GDPR`, which left an agent
  guessing at two things. It omitted SOX, which *is* assessed and is the one of the five least likely
  to be inferred from a prompt that says only "our auditors require it". And "e.g." never said
  whether naming a regime off that list was useful or quietly ignored — so an agent carrying a
  requirement for DPDP, CCPA or ISO 27001 had no way to decide whether to send it. Sending it is
  worth doing: a regime with no requirement catalogue behind it is still recorded and carried into
  the design brief as a requirement the agent has to satisfy itself, rather than dropped. The
  description now names the five that are checked and states that rule. The field still accepts any
  string — no schema change, and nothing different on the wire.

  Installed clients read the published `dist/`, so this reaches an agent when it takes this version.

## [0.1.1] — 2026-09-10

Everything the SkeletIQ API sends about a design now reaches the agent reading it. `0.1.0` mirrored
the API's response shapes by hand and left three fields unnamed. Because those shapes accept unknown
keys on purpose — so a published client keeps working against a newer server — nothing failed, and
the loss took two different forms. `grounded_decisions` was **dropped**: the design slice is rebuilt
from named keys, so it never reached the caller in any form. `release_warnings` and
`orphaned_answers` were **unread**: those two modes hand back the whole parsed response, so the
fields sat in `structuredContent` while the answer's prose — the part every host shows the model, and
the only part a tool's declared output promises — said nothing about them.

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
