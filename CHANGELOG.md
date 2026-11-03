# Changelog

Notable changes to `@skeletiq/mcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

npm releases are immutable, so nothing published is ever edited in place — a correction is always a
new version.

## [Unreleased]

## [0.6.0] — 2026-11-03

### Added

- **Merged requirement ids.** When a requirement was merged into another as a near-duplicate,
  `get_design` now lists the old id on the kept requirement's line, as `R7 (also R22)`. A component
  can still cite the merged id, and this tells your agent what it now means.

### Changed

- The wire schema accepts two new optional fields from the server: `lifecycle` on components and
  `answered` on grounded decisions. Neither is shown in tool output yet. Older servers work as before.

## [0.5.0] — 2026-10-21

### Changed

- `critique_architecture` labels its blended score "Design quality" (was "Architecture").

### Added

- **Verdict-first headline.** `get_design(mode: "readiness")` opens with the server's headline
  ("22 of 24 met · Ready · score 87") and, when the version was judged by older rules than today's,
  "Rules updated since this check". Older servers without the field read as before.
- **Agent schema version.** This package knows the agent schema version it was written against (2)
  and, when `get_design(mode: "fitness")` or `check_drift` reports a newer one from the SkeletIQ server, adds a line
  saying a newer `@skeletiq/mcp` understands more.
- **Decisions mode.** `get_design(mode: "decisions")` lists a version's decisions: the option
  chosen, why, what was rejected, and any removed requirement a decision still cites.
- **Decision requests.** `request_decision_change` proposes a change to a decision and says why;
  a person answers it in the app, and the request appears in their to-do list. Polling an accepted
  request names the version it was accepted at and, once a newer version exists, points you at it.
- **Fitness tests.** `get_design(mode: "fitness")` lists the tests to write in your own repo, and
  `check_drift` accepts each result under its `test_id`.
- **Evidence checks.** `check_drift` accepts a citation (a file and a quote or symbol) for each
  component and fitness result, checks it on your machine, and sends SkeletIQ only the path and
  whether it verified, never the quote. Covered components whose citation did not verify are named.
- **Question dependencies are shown.** Clarifying questions print the contract field each one
  resolves ("Resolves: …") and, for a dependent question, "Ask only if <question id> is answered
  <values>"; dependent questions are listed after the question they depend on. The structured
  `clarifying_questions` carry the same as `fork` and `asked_if` (null when absent).
- **A design's platform layer is shown.** `get_design` marks the parts the platform added or
  adopted, with the obligations each satisfies and their policies, lists the drawn connections the
  platform replaced, and marks the platform's decisions "(platform)". Designs without platform
  fields read as before.
- **Proposed requirements are marked.** `get_design` prefixes a requirement the design suggested
  rather than the person asked for with "[proposed]" and says to treat it as optional. Stated and
  accepted requirements, and older APIs without the field, read as before.

## [0.4.0] — 2026-09-28

### Added

- **A design written from a trimmed input says so.** When part of what the model was given had to
  be cut to fit its input window (a source left out, or the current design summarised), an inline
  `generate_architecture` run returns the server's sentence as `prompt_trim_note` and prints it as
  an "Input trimmed:" line. It is null when nothing was cut, and always null on `wait: false`,
  which returns before the run has a summary.
- **A runtime's spent shared allowance reads as one.** Some SkeletIQ runtimes run on a daily
  allowance shared by everyone using them, and the server now refuses a design on one that cannot
  cover it with `RUNTIME_ALLOWANCE_SPENT`, before anything is started or charged. The tool answer
  gives the server's sentence and the moment the allowance resets, offers no upgrade (no plan raises
  a shared allowance), and the error is not retryable, like the account's daily limit. No runtime an
  agent can be set to has such an allowance today; this reads one correctly if it ever does.

### Changed

- **A request rate of 0 in a progress line reads as no rate yet.** The line falls back to the user
  count, unlabelled, instead of printing "0/s".
- **A figure the user gave reads "(you set this)" in progress lines**, the words the app uses, where
  it read "(stated)".
- **How much data a design sends out can be stated, and "Not sure yet" answers that question
  too.** `generate_architecture`'s `constraints` accept `transfer_band` (`light` ~100 GB,
  `moderate` ~1 TB, `heavy` ~10 TB, `very_heavy` ~100 TB, `massive` ~1 PB a month) or
  `monthly_transfer_gb` (the same as a figure). SkeletIQ then prices data sent out to users at the
  cloud's published per-GB rates, and the estimate stops listing data transfer as not included. A
  first public design that serves content (video, files, downloads, a CDN) may now come back with a
  second question, `transfer`, after the load question; "Not sure yet" is a valid answer and keeps
  data transfer out of the price, said so. The comment that called the constraint keys "exactly"
  the server's list now says they are a subset of it.
- **A requirement only review advice fails says so.** A line the review's rules fail through
  advice alone no longer blocks handoff; `get_design` prints it as `unconfirmed (review advice)` and
  explains it once under the list, and the ledger row's new `advisory_only` field is accepted.
- **Progress-line copy follows the product's one vocabulary for where a figure came from.**
  `generate_architecture`'s progress notifications used to label an LLM-read figure "inferred"
  (`"4000 rps (inferred)"`); it now says `"read from your prompt"`, matching the wording the app
  uses beside the same numbers. The request-rate figure itself now reads `"4000/s"` rather than
  `"4000 rps"` — "RPS" is never printed, in a progress line or anywhere else. The
  `generate_architecture` schema's `burstiness` description no longer says "the tier default peak";
  it says "a typical peak for its scale".
- **A requirement that rests on an assumed load says so.** When nobody said how much traffic to
  expect, SkeletIQ sizes and prices a design on the typical load for its kind of system, and a budget
  or capacity line that fails on that load no longer blocks handoff. `get_design` prints such a line
  as `unconfirmed (assumed load)` — until now it read `unconfirmed (unstated split)`, which names a
  different cause — and explains it once under the list: ask your human for their load rather than
  guessing one.
- **A readiness check that could not be answered says what would answer it.** When the server
  reports what would settle an unanswered check (`clears`, for example "Saving a change runs it on
  the new version."), `get_design` in readiness mode prints it after the reason, so an agent can
  act on the check rather than only report it. The To do list's new "Couldn't check yet" group is
  printed by its label like any other, and each card's `counts_toward` (the readiness row it is
  counted on) is accepted.
- **`secondary_domains` no longer selects compliance frameworks.** A design is checked against the
  frameworks its primary domain usually needs plus the ones the user named; further domains add that
  domain's design checks as advice only. The `critique_architecture` description says so. `frameworks_checked`
  still lists exactly what was checked.
- **A first design that states no load is asked for one, and "Not sure yet" is a valid answer.**
  SkeletIQ now asks before designing when a new design's prompt states no load — no request rate,
  no fleet (how many devices, and how often each reports) and no volume ("2 million orders a day").
  A headcount alone ("150,000 employees") is not a load. The answer comes back as
  `clarification_required` with one question, `scale`: "What load should this be sized for?". Its
  options are "Not sure yet" and five bands, from about 5 to about 50,000 requests a second. The
  question's new `option_details` field gives each option a label and a line saying what it means,
  and the new `skip_effect` says what leaving it unanswered does. The connector prints both. "Not
  sure yet" is now listed as an answer, not a decline, so the connector offers it: the design is
  then sized on a typical load for its kind of system and marked assumed. The `generate_architecture`
  description now tells an agent to ask its human for the load first, to answer "Not sure yet" when
  they do not know it, and never to guess a band. This replaces "there is no way to skip the
  questions". A clarifying question may also carry `multiple` (more than one option may be picked);
  the connector accepts the field, and no question sets it yet.
- **An assumption the design is not sized on says so.** SkeletIQ now checks each assumption that
  states the whole system's read/write mix or peak against the figure the design is sized on. The
  `design-gaps` answer carries a new `sizing_conflict` field on such an assumption (what it states,
  what the design is sized on), and `get_design` in `gaps` mode prints it beside the assumption:
  "(this design is sized for 80% reads, not 70% reads)". An agent should build to the sizing, not
  the assumption. New designs leave such assumptions out unless a person accepted them.
- **A follow-up that names no part may be asked which parts it may change.** SkeletIQ now changes
  only the parts a follow-up names and keeps the rest as it was. An instruction that changes the
  design without naming anything ("make it more resilient") comes back as a `clarification_required`
  answer with one question, `change_scope`. Answer `Any part may change` to let the turn touch every
  part, or name the parts in the answer. The question's new `dismiss_options` field marks the option
  that means "rewrite the instruction instead" (`I'll name the parts`). The connector reads it and
  leaves it out of the answers it offers, the same way it leaves out `decline_options`: sent as an
  answer, it would run the change with nothing it may touch.
- **A requirement only a model check failed reads as unconfirmed, not failing.** SkeletIQ checks
  each requirement by capacity, cost, its review rules, or — where none of those applies — a
  language model reading the design. Only the first three are measurements, and the server now
  says so per row: `blocks_handoff` is true only for a `fails` one of them reached, and
  `unconfirmed_reason: "model_check"` marks a `fails` that only the model check reached. `get_design`
  prints such a line as `unconfirmed (model check) — verify before building for it`, counts it apart
  from `failing`, and explains the word under the list. An agent told a line fails adds a part for
  it; a model's opinion is a reason to look, not to build.

  Against a server that does not send `blocks_handoff`, the connector reads the method instead: a
  `fails` from capacity, cost or the review rules is failing, and one from the model check, or with
  no method recorded, is unconfirmed.
- **A capacity line that rests on an unstated split reads as unconfirmed.** A design's capacity
  can turn on something nobody said: the request rate divided evenly between two entry points, or
  traffic weights on one component's connections that do not add up to 1. When a stated rate falls
  short only under that assumption, the server marks the row `unconfirmed_reason: "unstated_input"`,
  names the assumption in the new optional `unstated_input` field, and does not block handoff on it.
  The row's reason also names the split the design would need — "It would hold it only if most of
  the traffic enters through Advertiser Users." — so the reader can judge whether that is
  realistic. `get_design` prints the line as `unconfirmed (unstated split)` and explains the word
  under the list. A line short however the
  split falls still reads `fails`. The readiness view lists a load gate in the same state under its
  own heading (`state: "unconfirmed"`), apart from the open gates, instead of dropping it.

## [0.3.0] — 2026-09-22

The vocabulary changes. A design's outstanding work now has one name on every surface — SkeletIQ
calls it the To do list — and the four-word requirement status it used to print is gone in favour
of the verdict it was a summary of.

### Added

- **Requirements a person has withdrawn are named rather than dropped.** A SkeletIQ design's
  requirement set is mostly inferred — the analysis writes it from the prompt — and a person can
  now say of any line either "yes, that is real" or "that is not a requirement". A withdrawn line
  leaves the requirement list, so nothing is held to it and no verdict is reported against it; a
  confirmed one reads `Inferred · confirmed` in the brief and the exported report, and changes
  nothing else.

  Components in a saved design keep citing the ids they were written with, so `mode: "component"`
  now says when one of them is no longer a requirement, and which way — withdrawn by a person, or
  an instruction an older analysis had recorded as a requirement. Without that the row would leave
  the answer in silence and the id on the component would resolve to nothing again, which is the
  gap the requirement ledger was added to close.

- **`get_design(mode: "todo")`.** Everything still to do on a version, one entry per problem
  whichever part of the product raised it. The review, the advisor and a pending decision routinely
  describe one problem three times; an agent reading them as three separate panels had no way to
  see that fixing one thing cleared all three. Entries come in three groups — what blocks a
  handoff, what is recommended, and what is waiting for the person to accept it — and each one
  names the sources that raised it, the components it affects, and how far back it goes ("carried
  from v3"), because a problem this version introduced and one that has survived four attempts are
  not the same news.

  If part of the version could not be read, the answer says so under its own heading instead of
  coming back shorter. An agent told "nothing is outstanding" by a list that quietly failed to load
  the simulation results is worse off than one told nothing at all.

  Each source on an entry carries what it raised, in the structured result beside the summary: a
  review finding arrives whole — the evidence, the fix, the precedent, the references and the
  confidence behind it, the same shape `critique_architecture` returns — and a pending decision
  arrives as the record it is asking to write, including whether the design already made that call
  or has not made it yet. Reading a problem should not need a second call to find out why it is one.

### Changed

- **Requirements print the verdict, not the status.** A row used to read `[unmet]` with no more to
  it. It now reads which check answered, what it said and why — `fails`, `passes`, `no_gap_found`,
  `not_checked`, `not_checkable` — with the reason the check gave and, for the model check, the
  model that gave it. `cited by nothing` is stated separately, because "nothing in the design
  claims to address this" is a different fact from any verdict about whether it holds. The four
  status words (`unmet`, `uncited`, `unchecked`, `cited`) are no longer printed; a server that
  predates the verdict still sends them, and its word is used rather than leaving the row blank.
- **`get_design(mode: "readiness")` stops filing "accept" rows under advisory checks.** An
  assumption the design made, or a decision waiting to be written down, is something a person
  agrees to. The old heading said those "never block, and some need a paid plan to clear" — wrong
  twice: accepting is free, and no check failed. They have their own heading now, and the readiness
  answer points at `mode: "todo"` for the same work item by item.
- **`mode: "readiness"` says when a check could not be answered, instead of reading as a pass.** A
  source that failed to load used to shorten the answer silently: a questions table that was down
  arrived as an empty list of open questions, which is indistinguishable from a design whose
  questions are all answered, and an agent was told the design was ready to build. The sources the
  server could not speak for are now named — the same set, and the same wording, `mode: "todo"`
  reports — and each says which of the two things happened. A read that broke leaves the answer
  genuinely incomplete and may answer differently if asked again; a check with nothing stored, where
  no review has been run or no simulation exists for the version, cannot. Only the first is a reason
  to retry, and neither is a reason to treat the design as clear.
- **`mode: "build_order"` fails instead of returning an empty order for a design it could not
  read.** A stored design that will not parse used to come back as a build order with no steps —
  byte-identical to a design that genuinely has no components, and the one answer an agent is most
  likely to act on by building nothing. It now returns the server's own sentence, the same way
  `check_drift` has always answered that failure.
- **`mode: "readiness"` and `mode: "todo"` can name `edge_direction` as a source they could not
  speak for.** A SkeletIQ design's arrows point from caller to callee, and the build order is
  derived from that. When a version's arrows cannot be placed in that convention, the answer now
  says so rather than serving an order derived from a direction nobody established.
- **`generate_architecture` says what it actually asks for.** Its description promised clarifying
  questions only for a prompt that "names no system at all". A prompt that names a system but no
  scale is asked too — how many users, how many requests — because a design built on an invented
  scale is sized, priced and judged against a number nobody chose. There is no flag to skip the
  questions, and the description now says so rather than leaving an agent to discover it.
- **Design gaps carry their problem key.** `gap:{id}`, the same identity the review, the advisor
  and the decision suggestions share, so a caller can tell that a question and a finding are about
  one thing.
- **`read_write_mix` and `burstiness` stop saying the prompt is ignored.** Both described themselves
  as fields nothing reads from the prompt, and `read_write_mix` added that it changed sizing only
  where a cache sits in front of a database. Neither is true any more: a read/write share written
  in the brief ("roughly 5% reads and 95% writes") is read and used, a stated peak ("peaking at
  2,000 per second") sets how peaky the traffic is, and the resulting read fraction now sizes
  components and weights read replicas — so on a read-heavy design it moves the instance counts and
  the cost. The fields still win over what the prompt says, and the descriptions say that instead.

## [0.2.1] — 2026-09-19

### Fixed

- **A requirement is not called failing only because nothing in the design cites it.** The ledger
  gives such a line the verdict `fails`, with the reason "Nothing in the design cites it." — a fact
  about what the design links, not a check that measured it. SkeletIQ's handoff gate stopped
  counting it, but the requirements heading still counted it as failing, the row printed
  `[fails · cited by nothing]`, and the legend said a `fails` is a gap a named check measured. On a
  real design that read "2 failing" where readiness said one requirement blocks, and an agent told a
  line fails tends to add a part for it. Such a line now prints and counts as `cited by nothing`
  only; a `fails` from simulation, cost, the review rules or the model check is unchanged.

- **`get_design` shows the requirements ledger it said it would.** `0.2.0` added the requirements a
  design was built from, and what became of each, to `overview` and `component` — and in practice
  neither ever printed one. To choose a version the connector reads the project's version list, and
  it kept those list items as if they were whole designs. The list is a summary: the API leaves the
  ledger off every item on purpose, because building it for a hundred versions to pick one is wasted
  work. So the connector described each version from a row that never carries a ledger, and every
  answer read like a design with no requirements analysis. Nothing failed, which is why it shipped:
  the test fixtures put the ledger on the list items, a shape the real API never sends.

  The version a session describes is now read on its own, from the endpoint that includes the
  ledger. That is one extra request per version described, not per version listed, and an overview
  followed by any number of component slices of the same version still share it. The fixtures now
  serve both reads in their real shapes, and a test fails if the ledger stops reaching either view.
- **`critique_architecture` no longer prints a framework nobody named as a failure.** A finding for a
  compliance framework the design never asked for is advice: the API marks it `advisory_only` and
  leaves it out of the score. The connector printed it like any other finding, so an unsaved payload,
  which names no frameworks, came back full of plain `[critical]` compliance lines. Those lines now
  read "advisory, not scored".
- **`get_design(mode: "readiness")` passes on why a check has no answer.** When the server could not
  answer a row for this version it says why — "computed for version 4, not this one", or "no advisor
  suggestions are stored for this version" — and that sentence was dropped, leaving a bare
  `not checked`. It is printed now. An unanswered advisory the server gives no reason for is marked
  `(no result for this version)` instead of `(never run on this version)`: a result can be missing
  because none is stored, which is not the same as nothing having run.

### Changed

- **Wording that promised more than the product does.** `constraints.read_write_mix` on
  `generate_architecture` now says it only changes sizing where a cache sits in front of a database,
  and has no effect elsewhere — which is what it does today. The `get_design` description says the
  requirements appear where a version records them, and says which way a connection points: the
  source calls the target, the same reading `build_order` already gave.

## [0.2.0] — 2026-09-18

### Changed

- **`get_design` marks the decisions a design rests on no cited source for.** The overview introduced
  every decision as "settled, build to them", including the ones the design itself flags with
  `assumption: true` because it could cite nothing behind them. An agent took a guess for a
  constraint and built to it. Those decisions now end in ` (assumption)`, and the heading says to
  confirm them first:
  `Decisions taken — build to them; confirm the ones marked (assumption) first, they rest on no cited source:`.
  The component slice does the same under "Decisions that mention it". When no decision is an
  assumption, both headings are unchanged, byte for byte. A decision that appears in both of the
  server's lists is marked when its grounded copy is an assumption, because the plain-string list
  carries no flag. The structured half gains `assumed_decisions`, the marked subset, on both
  modes. `design_decisions` and `related_decisions` stay plain strings.

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
