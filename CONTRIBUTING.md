# Contributing

Two things are worth knowing before you spend time here.

## This repository is a mirror

`@skeletiq/mcp` is developed in SkeletIQ's monorepo, next to the API it talks to. The connector's
request and response schemas and the server's routes change in the same commit, and keeping them in
one place is what stops them drifting apart. This repository is derived from that history with
`git subtree split`, so what you see is the package's real history — commit for commit, not a
squashed snapshot.

The practical consequence: **a pull request cannot be merged here.** The next sync would overwrite
it. That is not a judgement on the change; it is how the mirror works.

## What to do instead

**Open an issue.** It is the best route for anything — a bug, an error message that sent you the
wrong way, a tool returning something your agent can't act on, a capability that is missing.

**Open a pull request anyway if code says it better than prose.** Nobody will merge the branch, but
the change can be applied upstream with your authorship preserved, and the resulting commit appears
here on the next release. Say in the description that you're happy for it to be applied that way.

**Report security problems privately** — see [SECURITY.md](./SECURITY.md), not an issue.

## Running it

See [Development](./README.md#development). The test suite mocks the SkeletIQ API rather than calling
it, so a clean clone runs green with no token and no account:

```bash
npm install && npm test
```

If you are changing a tool's output, `src/wire/schemas.ts` is the place to start: it describes the
API's responses, and it is deliberately lenient — unknown fields pass through — because a published
client has to keep working against a server it was not built alongside.
