/**
 * The binary. Reads the environment, then serves MCP over stdio until the host closes it.
 *
 * Nothing may be written to stdout that is not a protocol message — stdout *is* the transport, and
 * a stray console.log corrupts the stream. Diagnostics go to stderr, which hosts surface as the
 * server's log.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { ConfigError, readConfig } from './config.js'
import { createServerFactory } from './server.js'

function main(): void {
    let config
    try {
        config = readConfig()
    } catch (error) {
        // Before the transport opens, so this lands in the host's startup log rather than
        // disappearing into a tool result the user never sees.
        process.stderr.write(
            `${error instanceof ConfigError ? error.message : String(error)}\n`,
        )
        process.exitCode = 1
        return
    }

    serveStdio(createServerFactory(config), {
        onerror: (error) => process.stderr.write(`skeletiq-mcp: ${error.message}\n`),
    })
}

main()
