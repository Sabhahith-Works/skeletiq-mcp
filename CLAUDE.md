# CLAUDE.md — packages/mcp

This is `@skeletiq/mcp`, the MCP server a coding agent connects to. It is **MIT-licensed inside an AGPL repo** (`NOTICE` records the split; keep it) and the only workspace with **no container**. Its targets run on host Node ≥20: `make mcp-build` / `mcp-test` / `mcp-lint` / `mcp-typecheck`, and `make lint-all` runs `mcp-lint`, `mcp-typecheck` and `mcp-build` — `dist/` is what the server executes and nothing else in the stack builds it.

Its git history is **mirrored publicly** at `github.com/Sabhahith-Works/skeletiq-mcp` (`git subtree split`, one-way), so **every commit message touching `packages/mcp` is public** — write them for that reader, and never author a file in the mirror; see `docs/runbooks/mcp-publish.md`.
