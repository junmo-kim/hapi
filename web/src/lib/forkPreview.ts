import { visibleBlockRole, type VisibleChatBlock } from '@/chat/toolGroups'

export type ForkPreviewTurn = {
    role: 'user' | 'assistant'
    text: string
}

export type ForkPreview = {
    /** Turns copied into the new session (shown above the fork point). */
    keptTurns: ForkPreviewTurn[]
    /** Text of the selected cutoff message, which is NOT copied into the
     * new session. Null for a current-tail fork where nothing is excluded. */
    boundaryText: string | null
}

const MAX_KEPT_TURNS = 3
const MAX_TURN_CHARS = 240

function truncate(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim()
    return collapsed.length > MAX_TURN_CHARS ? `${collapsed.slice(0, MAX_TURN_CHARS)}…` : collapsed
}

function blockPreviewText(block: VisibleChatBlock): { role: 'user' | 'assistant'; text: string } | null {
    const role = visibleBlockRole(block)
    if (role === 'system') return null
    let text: string | undefined
    if (block.kind === 'user-text' || block.kind === 'agent-text') {
        text = block.text
    } else if (block.kind === 'cli-output') {
        text = block.text
    }
    if (!text || text.trim().length === 0) return null
    return { role, text }
}

/**
 * Mirrors `hub/src/sync/forkTranscript.ts#selectForkTranscriptPrefix`:
 * a historical fork copies everything BEFORE the boundary message into the
 * new session — the boundary message itself and anything after it stay out
 * of the child; a current fork (no `messageLocalId`) copies the whole
 * transcript. Queued rows (`invokedAt == null`) are never copied, matching
 * the hub filter.
 */
export function buildForkPreview(blocks: readonly VisibleChatBlock[], messageLocalId?: string): ForkPreview {
    let cutoff = blocks.length
    let boundaryText: string | null = null
    if (messageLocalId) {
        cutoff = blocks.findLastIndex((block) => block.kind !== 'agent-event' && block.kind !== 'tool-group' && block.localId === messageLocalId)
        if (cutoff < 0) return { keptTurns: [], boundaryText: null }
        const selected = blockPreviewText(blocks[cutoff])
        boundaryText = selected ? truncate(selected.text) : null
    }

    const turns: ForkPreviewTurn[] = []
    for (const block of blocks.slice(0, cutoff)) {
        if (block.kind === 'user-text' && (block.invokedAt ?? null) === null) continue
        const entry = blockPreviewText(block)
        if (!entry) continue
        const previous = turns[turns.length - 1]
        if (previous && previous.role === entry.role) {
            previous.text = truncate(`${previous.text} ${entry.text}`)
        } else {
            turns.push({ role: entry.role, text: truncate(entry.text) })
        }
    }
    return { keptTurns: turns.slice(-MAX_KEPT_TURNS), boundaryText }
}
