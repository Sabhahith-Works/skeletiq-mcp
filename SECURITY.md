# Security

## Reporting a vulnerability

Email **security@skeletiq.com**. Please don't open a public issue for anything that could be used
against someone before it is fixed.

Useful to include: what you did, what happened, what you expected, and which version you were
running. `npx -y @skeletiq/mcp` resolves the latest release unless you pinned one, so if you did not
pin, say when you last started the server. A proof of concept helps and will not be shared beyond
the people fixing it.

## Supported version

The latest release published to npm. Fixes go out as a new version rather than as a patch to an
existing one — npm releases are immutable, so a fixed `0.1.x` is always a higher `0.1.x`.

## What this server does with your credentials

Worth reading before you hand any MCP server a token, and all of it is checkable in `src/`.

This connector runs on your machine, inside your coding agent, as a stdio process. It reads **one**
credential: a SkeletIQ personal API token, from the `SKELETIQ_API_KEY` environment variable
(`src/config.ts`). After it is read, that value appears in exactly one place in the code — the
`Authorization: Bearer` header in `src/http/client.ts` — and nowhere else. It is not written to
either of the server's two stderr diagnostics.

It sends that token to exactly one destination: the SkeletIQ API at `SKELETIQ_API_URL`, which
defaults to `https://api.skeletiq.com`. There is no other network call in the package, and no
telemetry.

It **does not touch your filesystem and starts no processes**. There is no `node:fs` import and no
`child_process` import anywhere in `src/` — so it reads no source, writes no files, and caches
nothing to disk. When the docs describe a brief being written into your repository's `AGENTS.md`,
that is your coding agent writing it, using text this server returned.

## Scoping the token you give it

A SkeletIQ token carries explicit scopes, and this server needs only the ones you intend to use —
`read` alone lets an agent orient and build without spending anything. The README's
[Scopes](./README.md#scopes) section is the authoritative table of which tool needs which; grant the
smallest set that covers what you want, because that is the blast radius if the token leaks.

Tokens are revocable in SkeletIQ under **Settings → Agent access**. If you believe one has been
exposed, revoke it there first, then tell us if the exposure came from this software.
