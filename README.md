# @skeletiq/mcp

Design in [SkeletIQ](https://skeletiq.com), build with your coding agent.

SkeletIQ turns a prompt into a critiqued system architecture — components, data stores,
connections, decisions, open questions — that you refine on a canvas and then **release**. This MCP
server hands that release to any MCP-capable coding agent: it orients from a brief written into
your repository's `AGENTS.md`, builds in a deterministic order, and reports back what it built.

## Install

Nothing to install — the server runs via `npx`.

You need a **personal API token**: in SkeletIQ, go to **Settings → Agent access**, create one, and
copy it (it is shown once).

### Claude Code

```bash
claude mcp add skeletiq \
  --env SKELETIQ_API_KEY=skq_your_token_here \
  -- npx -y @skeletiq/mcp
```

### opencode

```json
{
  "mcp": {
    "skeletiq": {
      "type": "local",
      "command": ["npx", "-y", "@skeletiq/mcp"],
      "environment": { "SKELETIQ_API_KEY": "{env:SKELETIQ_API_KEY}" },
      "timeout": 600000
    }
  }
}
```

The `timeout` matters. A generation runs for around 217 seconds typically and up to 450 at the
limit; opencode's default is far below that, and it will kill a perfectly healthy run.

### Any other host

Run `npx -y @skeletiq/mcp` over stdio with `SKELETIQ_API_KEY` in the environment.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SKELETIQ_API_KEY` | yes | — | A personal API token, starting `skq_`. Not a browser session token. |
| `SKELETIQ_API_URL` | no | `https://api.skeletiq.com` | For self-hosted installs. A trailing `/api/v1` is accepted and trimmed. |

## Scopes

A token grants only what you tick. The server's tools need:

| Scope | What it unlocks | Tools |
|---|---|---|
| `read` | Projects, designs, briefs, build order, readiness, gaps, jobs | `list_projects`, `get_design`, `get_generation_status` |
| `generate` | Running generations and payload critique. **Spends credits.** | `generate_architecture`, `critique_architecture` |
| `report` | Recording what got built | `check_drift` |

`read` alone is a good starting point: the agent can orient and build, but cannot spend anything.

Everything else is out of reach by construction — a token cannot mint another token, read or
change your provider keys, see billing, or delete your account, whatever scopes it carries.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Find a project by name. Returns the candidates rather than guessing between them. |
| `get_design` | Read a design, in one of six modes: `overview`, `component`, `brief`, `readiness`, `build_order`, `gaps`. |
| `generate_architecture` | Design a system from a prompt. Spends credits and takes minutes. |
| `get_generation_status` | Poll a generation started with `wait: false`. |
| `critique_architecture` | Check a design against SkeletIQ's rules. Deterministic, free, stores nothing. |
| `check_drift` | Report what you built; hear what is missing, half done, or not in the design. |

## How a session goes

1. `list_projects` → resolve the project a person named.
2. `get_design(mode: "brief")` → write the fenced block into `AGENTS.md`.
3. `get_design(mode: "readiness")` → see what is still undecided, and ask.
4. `get_design(mode: "build_order")` → build in that order.
5. `get_design(mode: "component", component_id: …)` → read each piece as you reach it.
6. `check_drift(covers: [...])` → report progress.

## Three things to know

**The brief is a managed block.** It goes inside a `skeletiq:brief` HTML-comment fence in your
`AGENTS.md`. A refresh replaces the whole block. Never append a second, and never edit inside one:
your edits will disappear on the next refresh, silently.

**A draft is not a release.** An unreleased version changes on every canvas save, with nothing to
tell your repository it moved. The tools label drafts, and tell you when a newer release exists.

**Component ids belong to one version.** A regeneration mints new ones. When `check_drift` returns
unknown ids with suggestions, they are suggestions — put them to a person rather than assuming the
mapping.

## Which model runs a generation

Whichever one the account holder chose under **Settings → Agent access**. The tools take no runtime
argument, deliberately: the model asking for a design does not get to choose what it costs you.

## Licence

MIT — see [LICENSE](./LICENSE). The rest of the SkeletIQ repository is AGPL-3.0-or-later; this
connector is MIT so it can be embedded, vendored and forked freely.
