import { defineConfig } from 'vitest/config'

// `node`, not the repo's usual `jsdom`: this package never touches a DOM, and running it under
// one would let a browser-only global reach production code that has no browser to run in.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
    },
})
