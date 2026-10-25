import {
    OPENCODE_CONVERSATION_HISTORY_INITIAL,
    markSupported,
    markUnsupported,
    toConversationHistoryCapabilities,
    type ConversationHistoryCapabilityStates
} from '@hapi/protocol/conversationHistory';
import type { ForkConversationRpcResult } from '@hapi/protocol/apiTypes';
import type { FetchLike } from './utils/opencodeCompactBridge';

type BunFetchInit = RequestInit & { timeout?: false };

type OpencodeMessageEntry = {
    info?: {
        id?: unknown;
        role?: unknown;
    };
};

type HistoryContext = {
    baseUrl: string | null;
    sessionId: string | null;
    mode?: 'v1' | 'v2';
    headers?: Record<string, string>;
};

function isRouteMissing(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\((404|405)\)/.test(message);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

const FORK_PATH_MARKERS = ['session/{sessionID}/fork', 'session/{id}/fork', 'session/:id/fork'];

export class OpencodeConversationHistory {
    private states: ConversationHistoryCapabilityStates = { ...OPENCODE_CONVERSATION_HISTORY_INITIAL };
    private readonly promptIndexByLocalId = new Map<string, number>();
    private busy = false;
    private publishCapabilities: (() => Promise<void>) | null = null;

    constructor(
        private readonly getContext: () => HistoryContext,
        fetchImpl?: FetchLike
    ) {
        this.fetchFn = fetchImpl ?? (async (url: string, init?: RequestInit) => {
            const bunInit: BunFetchInit = { ...init, timeout: false } as BunFetchInit;
            return await fetch(url, bunInit as RequestInit);
        });
    }

    private readonly fetchFn: FetchLike;

    setPublishCapabilities(fn: () => Promise<void>): void {
        this.publishCapabilities = fn;
    }

    /** Pushes current history points/indexes into session metadata (best-effort). */
    async publish(): Promise<void> {
        await this.publishCapabilities?.()
    }

    /** Permanently hides fork affordances (e.g. after native/HAPI divergence). */
    async disableFork(): Promise<void> {
        this.states = markUnsupported(markUnsupported(this.states, 'forkCurrent'), 'forkAtMessage');
        await this.publishCapabilities?.();
    }

    /** Drops all persisted locators (e.g. compaction reindexes native history). */
    clearPromptIndexes(): void {
        this.promptIndexByLocalId.clear();
    }

    setBusy(busy: boolean): void {
        this.busy = busy;
    }

    rememberPromptIndex(localId: string | undefined, promptIndex: number | null | undefined): void {
        if (!localId || promptIndex == null || !Number.isInteger(promptIndex) || promptIndex < 0) return;
        this.promptIndexByLocalId.set(localId, promptIndex);
    }

    getCapabilitiesForMetadata() {
        const conversationHistory = toConversationHistoryCapabilities(this.states);
        return conversationHistory ? { conversationHistory } : undefined;
    }

    getHistoryPoints(): Record<string, true> {
        const points: Record<string, true> = {};
        for (const localId of this.promptIndexByLocalId.keys()) {
            points[localId] = true;
        }
        return points;
    }

    getHistoryIndexes(): Record<string, number> {
        const indexes: Record<string, number> = {};
        for (const [localId, promptIndex] of this.promptIndexByLocalId.entries()) {
            indexes[localId] = promptIndex;
        }
        return indexes;
    }

    restorePromptIndexes(indexes: Record<string, number> | null | undefined): void {
        if (!indexes) return;
        for (const [localId, promptIndex] of Object.entries(indexes)) {
            if (typeof localId !== 'string' || localId.length === 0) continue;
            if (!Number.isInteger(promptIndex) || promptIndex < 0) continue;
            this.promptIndexByLocalId.set(localId, promptIndex);
        }
    }

    async probeCapabilities(signal?: AbortSignal): Promise<void> {
        const { baseUrl, sessionId } = this.getContext();
        if (!baseUrl || !sessionId) return;

        try {
            // `/openapi.json` serves an HTML app shell with HTTP 200 on some
            // versions, so a marker miss must fall through to the next
            // candidate rather than concluding "unsupported".
            let forkSupported = false;
            for (const url of [`${baseUrl}/doc`, `${baseUrl}/openapi.json`]) {
                let bodyText: string | null = null;
                try {
                    bodyText = await this.fetchDocText(url, signal);
                } catch {
                    // A missing/failing endpoint must not abort the probe —
                    // fall through to the next candidate.
                    continue;
                }
                if (bodyText !== null && FORK_PATH_MARKERS.some((marker) => bodyText.includes(marker))) {
                    forkSupported = true;
                    break;
                }
            }
            this.states = forkSupported
                ? markSupported(markSupported(this.states, 'forkCurrent'), 'forkAtMessage')
                : markUnsupported(markUnsupported(this.states, 'forkCurrent'), 'forkAtMessage');
        } catch {
            // Any network failure hides the capability rather than showing a broken affordance.
            this.states = markUnsupported(markUnsupported(this.states, 'forkCurrent'), 'forkAtMessage');
        }
        this.states = markUnsupported(this.states, 'rewindToMessage');

        // A torn-down launcher must not overwrite a successor's fresher state.
        if (signal?.aborted) return;
        await this.publishCapabilities?.();
    }

    private async fetchDocText(url: string, signal?: AbortSignal): Promise<string> {
        const response = await this.fetchFn(url, {
            method: 'GET',
            headers: this.getContext().headers,
            signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])])
        });
        if (!response.ok) throw new Error(`GET ${url} failed (${response.status})`);
        return await response.text();
    }

    async fork(messageLocalId?: string): Promise<ForkConversationRpcResult> {
        if (this.busy) throw new Error('Session is busy');
        const { baseUrl, sessionId, mode, headers } = this.getContext();
        if (!baseUrl || !sessionId) throw new Error('OpenCode session is not ready');

        let messageID: string | undefined;
        if (messageLocalId) {
            if (this.states.forkAtMessage === 'unsupported') {
                throw new Error('Historical fork is not supported');
            }
            const targetPromptIndex = this.promptIndexByLocalId.get(messageLocalId);
            if (targetPromptIndex == null) {
                throw new Error(`No native history point for message ${messageLocalId}`);
            }
            messageID = await this.resolveUserMessageID(baseUrl, sessionId, targetPromptIndex);
        } else if (this.states.forkCurrent === 'unsupported') {
            throw new Error('Fork current is not supported');
        }

        try {
            const response = await this.fetchFn(
                `${baseUrl}${mode === 'v2' ? '/api' : ''}/session/${encodeURIComponent(sessionId)}/fork`,
                {
                    method: 'POST',
                    headers: { ...headers, 'content-type': 'application/json' },
                    body: JSON.stringify(messageID ? (mode === 'v2' ? { before: messageID } : { messageID }) : {}),
                    signal: AbortSignal.timeout(10_000)
                }
            );
            if (!response.ok) {
                throw new Error(`OpenCode fork request failed (${response.status}): ${(await response.text().catch(() => '')).slice(0, 300)}`);
            }
            const data: unknown = await response.json().catch(() => null);
            const session = mode === 'v2' && isObjectRecord(data) ? data.data : data;
            const nativeSessionId = asString(isObjectRecord(session) ? session.id : null);
            if (!nativeSessionId) throw new Error('OpenCode fork did not return a session id');

            this.states = markSupported(this.states, 'forkCurrent');
            this.states = markSupported(this.states, 'forkAtMessage');
            await this.publishCapabilities?.();
            return { nativeSessionId };
        } catch (error) {
            // Only a missing route hides the capability; transient network or
            // server errors must not permanently disable an advertised fork.
            // Both fork modes share this endpoint, so a 404/405 disables both.
            if (isRouteMissing(error)) {
                this.states = markUnsupported(
                    markUnsupported(this.states, 'forkCurrent'),
                    'forkAtMessage'
                );
                await this.publishCapabilities?.();
            }
            throw error;
        }
    }

    private async resolveUserMessageID(baseUrl: string, sessionId: string, targetPromptIndex: number): Promise<string> {
        if (this.getContext().mode === 'v2') {
            const messages = await this.fetchV2UserMessages(baseUrl, sessionId, AbortSignal.timeout(10_000));
            const id = asString(messages[targetPromptIndex]?.id);
            if (!id) throw new Error(`OpenCode has no user message at index ${targetPromptIndex}`);
            return id;
        }
        const response = await this.fetchFn(
            `${baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
            { method: 'GET', signal: AbortSignal.timeout(10_000) }
        );
        if (!response.ok) throw new Error(`OpenCode message lookup failed (${response.status})`);
        const data: unknown = await response.json().catch(() => null);
        if (!Array.isArray(data)) throw new Error('OpenCode message list is not available');
        let userCount = -1;
        for (const entry of data as OpencodeMessageEntry[]) {
            if (entry?.info?.role !== 'user') continue;
            userCount++;
            if (userCount === targetPromptIndex) {
                const id = asString(entry.info?.id);
                if (!id) throw new Error(`OpenCode user message at index ${targetPromptIndex} has no id`);
                return id;
            }
        }
        throw new Error(`OpenCode has no user message at index ${targetPromptIndex}`);
    }

    /** Number of user messages already in the native session, or null when unknown. */
    async getNativeUserMessageCount(signal?: AbortSignal): Promise<number | null> {
        const { baseUrl, sessionId } = this.getContext();
        if (!baseUrl || !sessionId) return null;
        try {
            if (this.getContext().mode === 'v2') {
                const combined = AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]);
                return (await this.fetchV2UserMessages(baseUrl, sessionId, combined)).length;
            }
            const response = await this.fetchFn(
                `${baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
                // Bounded wait: this lookup runs before every first prompt, so a
                // stalled loopback endpoint must not block the turn forever.
                { method: 'GET', signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]) }
            );
            if (!response.ok) return null;
            const data: unknown = await response.json().catch(() => null);
            if (!Array.isArray(data)) return null;
            let count = 0;
            for (const entry of data as OpencodeMessageEntry[]) {
                if (entry?.info?.role === 'user') count++;
            }
            return count;
        } catch {
            return null;
        }
    }

    private async fetchV2UserMessages(baseUrl: string, sessionId: string, signal: AbortSignal): Promise<Record<string, unknown>[]> {
        const messages: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        do {
            const query = new URLSearchParams({ type: 'user', limit: '200' });
            if (cursor) query.set('cursor', cursor);
            else query.set('order', 'asc');
            const response = await this.fetchFn(
                `${baseUrl}/api/session/${encodeURIComponent(sessionId)}/message?${query}`,
                { method: 'GET', headers: this.getContext().headers, signal }
            );
            if (!response.ok) throw new Error(`OpenCode message lookup failed (${response.status})`);
            const data: unknown = await response.json();
            if (!isObjectRecord(data) || !Array.isArray(data.data)) throw new Error('OpenCode message list is not available');
            for (const entry of data.data) {
                if (!isObjectRecord(entry) || entry.type !== 'user' || !asString(entry.id)) {
                    throw new Error('OpenCode returned an invalid user message');
                }
                messages.push(entry);
            }
            cursor = isObjectRecord(data.cursor) ? asString(data.cursor.next) : null;
            if (cursor && seen.has(cursor)) throw new Error('OpenCode repeated a message cursor');
            if (cursor) seen.add(cursor);
        } while (cursor);
        return messages;
    }
}
