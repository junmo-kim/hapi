import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectPath } from './utils/path'

export type NativeTurn = {
    /** uuid of the user prompt entry that starts the turn. */
    promptUuid: string
    /** uuid of the last user/assistant entry belonging to the turn. */
    endUuid: string
}

type TranscriptEntry = {
    type?: string
    uuid?: string
    isSidechain?: boolean
    message?: { content?: unknown }
}

function isPromptEntry(entry: TranscriptEntry): boolean {
    const content = entry.message?.content
    if (typeof content === 'string') return true
    return Array.isArray(content) && content.some((block) => (block as { type?: string } | null)?.type === 'text')
}

/**
 * Parse the native Claude transcript for a session into ordered turns.
 * The transcript is append-only; rewinds re-parent new turns, so dropped
 * entries remain in the file. Only completed prompt turns are reported.
 */
export function readNativeTurns(workingDirectory: string, sessionId: string): NativeTurn[] {
    const file = join(getProjectPath(workingDirectory), `${sessionId}.jsonl`)
    if (!existsSync(file)) return []
    const turns: NativeTurn[] = []
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        let entry: TranscriptEntry
        try {
            entry = JSON.parse(line)
        } catch {
            continue
        }
        if (entry.isSidechain) continue
        if ((entry.type !== 'user' && entry.type !== 'assistant') || typeof entry.uuid !== 'string') continue
        if (entry.type === 'user') {
            if (!isPromptEntry(entry)) continue
            turns.push({ promptUuid: entry.uuid, endUuid: entry.uuid })
        } else if (turns.length > 0) {
            turns[turns.length - 1]!.endUuid = entry.uuid
        }
    }
    return turns
}

export type RewindPlan = {
    resumeSessionAt?: string
    dropsTurns: string[]
}

/**
 * Build the resume flags to drop turns `[dropFromTurnIndex, turns.length)`.
 * The kept boundary is the last entry of the previous turn; dropping every
 * turn including the first is not representable and is rejected.
 */
export function resolveRewindPlan(turns: NativeTurn[], dropFromTurnIndex: number): RewindPlan {
    if (dropFromTurnIndex < 0 || dropFromTurnIndex >= turns.length) {
        throw new Error('Selected message has no native history to drop')
    }
    if (dropFromTurnIndex === 0) {
        throw new Error('Cannot rewind the first message')
    }
    return {
        resumeSessionAt: turns[dropFromTurnIndex - 1]!.endUuid,
        dropsTurns: turns.slice(dropFromTurnIndex).map((turn) => turn.promptUuid)
    }
}
