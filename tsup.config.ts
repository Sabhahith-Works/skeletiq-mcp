import { defineConfig } from 'tsup'

// One bundled ESM file behind a shebang. `npx @skeletiq/mcp` pays the cold start on every
// invocation, and a bundle is the difference between one file read and a few hundred.
//
// Dependencies stay external: the MCP SDK resolves its own subpath exports at runtime, and a
// bundler that inlines it is a bundler that has to be right about all of them.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    outDir: 'dist',
    clean: true,
    dts: false,
    sourcemap: false,
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
})
