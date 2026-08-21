/**
 * Reading SkeletIQ's generation stream.
 *
 * The stream has **no `event:` names** — every frame is a bare `data:` line carrying one
 * serialized `StreamChunk`, discriminated by its own `type` field. There is no `[DONE]` sentinel
 * and no keepalive comment: the terminal frames are `done` and `error`, and after either one the
 * response simply ends.
 *
 * The consequence worth stating: once the first byte is out the HTTP status is already 200, so a
 * generation that fails halfway reports it *in band*, as a frame. A reader that only checks the
 * status code sees a successful, empty generation.
 */

export interface SseFrame {
    type: string
    [key: string]: unknown
}

/**
 * Yield one parsed frame at a time.
 *
 * Frames arrive split across network chunks — a 200 KB architecture payload is several — so the
 * buffer is carried between reads and only complete `\n\n`-terminated records are parsed. Doing
 * this per chunk instead is the classic way to lose exactly the largest and most important frame.
 */
export async function* readSseFrames(response: Response): AsyncGenerator<SseFrame> {
    const body = response.body
    if (!body) return

    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true })

        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
            const record = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const frame = parseRecord(record)
            if (frame) yield frame
            boundary = buffer.indexOf('\n\n')
        }
    }

    // A final record with no trailing blank line: legal SSE, and what a stream cut short by a
    // deadline looks like.
    const trailing = parseRecord(buffer)
    if (trailing) yield trailing
}

function parseRecord(record: string): SseFrame | null {
    const data = record
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')

    if (!data) return null

    try {
        const parsed: unknown = JSON.parse(data)
        if (parsed && typeof parsed === 'object' && typeof (parsed as SseFrame).type === 'string') {
            return parsed as SseFrame
        }
    } catch {
        // A frame that is not JSON is not something this client can act on, and throwing here
        // would discard the frames that came before it. Skipping keeps the terminal frame
        // reachable, which is the one that decides whether the generation succeeded.
    }
    return null
}
