import { getNativeChatStore, getNativeSessionId, isKnownFlavor, recoversNativeIdFromMessages } from '@hapi/protocol'
import type { Session } from '@/types/api'

/** Transport liveness alone cannot tell whether the agent process has stopped. */
export function inactiveSessionBannerKey(session: Pick<Session, 'active' | 'metadata'>, checking: boolean, resumable: boolean) {
    if (session.active) return null
    if (checking) return 'session.inactive.checking'
    if (session.metadata?.lifecycleState === 'archived') {
        return resumable ? 'session.inactive.autoResume' : 'session.inactive.cannotResume'
    }
    return resumable ? 'session.inactive.disconnectedResume' : 'session.inactive.disconnected'
}

/** Agent thread id used by hub `resolveAgentResumeId`, flavor-specific.
 *  Mirrors hub: cross-flavor ids are ignored to avoid the web layer claiming a
 *  session is resumable when the hub will only honor the current flavor's id.
 */
export function resolveAgentSessionIdFromMetadata(
    metadata: Session['metadata'] | null | undefined,
): string | undefined {
    if (!metadata) {
        return undefined
    }
    const flavor = isKnownFlavor(metadata.flavor) ? metadata.flavor : 'claude'
    return getNativeSessionId(metadata, flavor) ?? undefined
}

/**
 * Whether an inactive session can be activated via resume (or fresh spawn on first send).
 * Matches hub: resume with agent id, or fresh spawn when path exists, no agent id, no user messages.
 * Flavors declaring message recovery with messages but no flavor-specific id
 * may attempt the hub-authoritative stored-message recovery path; the hub
 * still rejects logs without a safe resume id.
 *
 * Cursor: definitive `onDisk: false` still blocks. Probe failure / unknown
 * (`undefined`) must NOT be treated as missing data — allow reopen and show
 * honest messaging (#1084).
 */
export function inactiveSessionCanResume(
    session: Session,
    userMessageCount: number,
    cursorChatOnDisk?: boolean,
): boolean {
    if (session.active) {
        return true
    }
    if (!session.metadata?.path) {
        return false
    }
    const flavor = isKnownFlavor(session.metadata.flavor) ? session.metadata.flavor : 'claude'
    if (resolveAgentSessionIdFromMetadata(session.metadata)) {
        if (getNativeChatStore(flavor) !== null) {
            return cursorChatOnDisk !== false
        }
        return true
    }
    if (recoversNativeIdFromMessages(flavor) && userMessageCount > 0) {
        return true
    }
    return userMessageCount === 0
}

export type CursorReopenGateReason = 'missing' | 'checking'

/**
 * UI gate for Cursor reopen. Only definitive `onDisk: false` disables reopen.
 * Probe errors / unknown status allow the attempt (soft-fail) with optional
 * unverified messaging.
 */
export function resolveCursorReopenGate(args: {
    applicable: boolean
    onDisk: boolean | undefined
    error: string | null
    isLoading: boolean
}): { disabledReason: CursorReopenGateReason | null; probeUnverified: boolean } {
    if (!args.applicable) {
        return { disabledReason: null, probeUnverified: false }
    }
    if (args.onDisk === false) {
        return { disabledReason: 'missing', probeUnverified: false }
    }
    if (args.onDisk === true) {
        return { disabledReason: null, probeUnverified: false }
    }
    if (args.error) {
        return { disabledReason: null, probeUnverified: true }
    }
    if (args.isLoading) {
        return { disabledReason: 'checking', probeUnverified: false }
    }
    return { disabledReason: 'checking', probeUnverified: false }
}
