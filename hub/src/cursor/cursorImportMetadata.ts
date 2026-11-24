import { platform } from 'node:os'
import { getNativeSessionId, withNativeSessionId } from '@hapi/protocol'
import type { Metadata } from '@hapi/protocol/types'
import type { Store } from '../store'

/**
 * Metadata helpers for Cursor local-session import (attach after ACP prepare).
 * Discovery + verify/transplant live on the runner; the hub only stamps rows.
 */

export function buildAlreadyImportedCursorIndex(
    store: Store,
    namespace: string,
    machineId: string
): Map<string, string> {
    const map = new Map<string, string>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = session.metadata as Metadata | null
        if (!metadata || metadata.flavor !== 'cursor') continue
        if (metadata.machineId !== machineId) continue
        const csid = getNativeSessionId(metadata, 'cursor')
        if (csid !== undefined && csid.length > 0) {
            map.set(csid, session.id)
        }
    }
    return map
}

export function buildImportedCursorSessionMetadata(args: {
    uuid: string
    workspacePath: string | null
    title: string
    hostName: string
    homeDir: string
    machineId?: string | null
}): Metadata {
    const now = Date.now()
    const metadata: Metadata = {
        path: args.workspacePath ?? '',
        host: args.hostName,
        homeDir: args.homeDir,
        os: platform(),
        name: args.title,
        summary: { text: args.title, updatedAt: now },
        flavor: 'cursor',
        // Strict ACP-only: prepare/verify must have passed before this is called.
        cursorSessionProtocol: 'acp',
        lifecycleState: 'imported',
        lifecycleStateSince: now,
        ...(args.machineId ? { machineId: args.machineId } : {})
    }
    return withNativeSessionId(metadata, 'cursor', args.uuid)
}
