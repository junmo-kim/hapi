import { describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import { observeLocalHistory, createLocalHistoryPublisher } from './localHistory';
import { OpencodeConversationHistory } from './conversationHistory';

const base: Metadata = { path: '/tmp/project', host: 'fixture',
    capabilities: { conversationHistory: { forkCurrent: true } },
    opencodeHistoryCheckpoint: { sessionId: 'ses_1', messageIds: ['msg_c'], userMessageIds: ['msg_c'], localMessageIds: [] } };

function historyFor(metadata: Metadata, ids: string[]) {
    const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://fixture', sessionId: 'ses_1' }),
        async () => new Response(JSON.stringify(ids.map((id) => ({ info: { id, role: 'user' } })))));
    history.restoreCheckpoint(metadata.opencodeHistoryCheckpoint);
    return history;
}

describe('local publication identity observations', () => {
    it('refuses unobserved native conversation growth after a publisher crash', async () => {
        await expect(historyFor(base, ['msg_c', 'msg_unpublished']).reconcileHistory()).rejects.toThrow('diverged');
    });

    it('does not trust a local publication that was not committed before the wrapper exited', async () => {
        const pending = { ...base, opencodeHistoryCheckpoint: { ...base.opencodeHistoryCheckpoint!,
            localMessageIds: ['msg_a'], localPublicationPending: true as const } };
        await expect(historyFor(pending, ['msg_c', 'msg_a']).reconcileHistory()).rejects.toThrow('diverged');
    });

    it('detects local A -> undo A -> B even though the remote checkpoint prefix C survives', async () => {
        const observedA = observeLocalHistory(base, 'ses_1', 'msg_a');
        const observedB = observeLocalHistory(observedA, 'ses_1', 'msg_b');
        expect(observedB.opencodeHistoryCheckpoint?.localMessageIds).toEqual(['msg_a', 'msg_b']);
        const history = historyFor(observedB, ['msg_c', 'msg_b']);
        await expect(history.reconcileHistory()).rejects.toThrow('diverged');
        expect(history.isDiverged()).toBe(true);
    });

    it('adopts append-only local publications and absorbs their observations into the new snapshot', async () => {
        const a = observeLocalHistory(base, 'ses_1', 'msg_a');
        const b = observeLocalHistory(observeLocalHistory(a, 'ses_1', 'msg_a'), 'ses_1', 'msg_b');
        expect(b.opencodeHistoryCheckpoint?.localMessageIds).toEqual(['msg_a', 'msg_b']);
        const history = historyFor(b, ['msg_c', 'msg_a', 'msg_b']);
        await expect(history.reconcileHistory()).resolves.toBe(3);
        expect(history.getCheckpoint()?.localMessageIds).toEqual([]);
        expect(history.isDiverged()).toBe(false);
    });

    it('tracks local-only turns even when no remote checkpoint existed yet', async () => {
        const a = observeLocalHistory({ path: '/tmp/project', host: 'fixture' }, 'ses_1', 'msg_a');
        const b = observeLocalHistory(a, 'ses_1', 'msg_b');
        await expect(historyFor(b, ['msg_b']).reconcileHistory()).rejects.toThrow('diverged');
    });

    it.each([null, 'different-session'])('fails closed when the publication cannot be tied to the native session (%s)', (sessionId) => {
        const observed = observeLocalHistory(base, sessionId, 'msg_a');
        expect(observed.conversationHistoryDiverged).toBe(true);
        expect(observed.capabilities?.conversationHistory).toBeUndefined();
        expect(observed.opencodeHistoryCheckpoint).toBeUndefined();
    });

    it('fails closed for content without a native message id and never clears persisted divergence', () => {
        const unknown = observeLocalHistory(base, 'ses_1', null);
        expect(unknown.conversationHistoryDiverged).toBe(true);
        expect(observeLocalHistory(unknown, 'ses_1', 'msg_a')).toBe(unknown);
    });

    it('does not silently upgrade an older checkpoint whose local publications were not tracked', async () => {
        const { localMessageIds, ...legacy } = base.opencodeHistoryCheckpoint!;
        const old: Metadata = { ...base, opencodeHistoryCheckpoint: legacy };
        expect(observeLocalHistory(old, 'ses_1', 'msg_b').conversationHistoryDiverged).toBe(true);
        await expect(historyFor(old, ['msg_c', 'msg_b']).reconcileHistory()).rejects.toThrow('diverged');
    });
});

describe('durable local publication journal', () => {
    it('waits for the identity guard ACK before content and retains it until content is acknowledged', async () => {
        let guardAck!: () => void;
        let contentAck!: () => void;
        const guard = new Promise<void>((resolve) => { guardAck = resolve; });
        const content = new Promise<void>((resolve) => { contentAck = resolve; });
        let metadata: Metadata = structuredClone(base);
        const changes: Array<(value: Metadata) => Metadata> = [];
        let flushes = 0;
        const client = {
            updateMetadata(handler: (value: Metadata) => Metadata) { changes.push(handler); },
            materialize: async () => true,
            flushMetadata: vi.fn(async () => {
                if (++flushes === 1) await guard;
                for (const handler of changes.splice(0)) metadata = handler(metadata);
                return true;
            }),
            flush: vi.fn(async () => { await content; return true; })
        };
        const errors = vi.fn();
        const publisher = createLocalHistoryPublisher(client, errors);
        const sent: string[] = [];
        publisher.publish('ses_1', 'msg_a', () => {
            sent.push('a');
        });
        await vi.waitFor(() => expect(changes).toHaveLength(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sent).toEqual([]);
        expect(client.flushMetadata).toHaveBeenCalledTimes(1);
        guardAck();
        await vi.waitFor(() => expect(sent).toEqual(['a']));
        expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBe(true);
        await expect(historyFor(metadata, ['msg_c', 'msg_a']).reconcileHistory()).rejects.toThrow('diverged');
        contentAck();
        await publisher.flush();
        expect(errors).not.toHaveBeenCalled();
        expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBeUndefined();
        await expect(historyFor(metadata, ['msg_c', 'msg_a']).reconcileHistory()).resolves.toBe(2);
    });

    it.each(['metadata', 'content'])('stops further forwarding and leaves restart verifiably unsafe on %s failure', async (failure) => {
        let metadata: Metadata = structuredClone(base);
        const changes: Array<(value: Metadata) => Metadata> = [];
        const client = {
            updateMetadata(handler: (value: Metadata) => Metadata) { changes.push(handler); },
            materialize: async () => true,
            flushMetadata: async () => {
                if (failure === 'metadata') return false;
                for (const handler of changes.splice(0)) metadata = handler(metadata);
                return true;
            },
            flush: async () => failure !== 'content'
        };
        const errors = vi.fn();
        const publisher = createLocalHistoryPublisher(client, errors);
        const sent: string[] = [];
        publisher.publish('ses_1', 'msg_a', () => { sent.push('a'); });
        publisher.publish('ses_1', 'msg_b', () => { sent.push('b'); });
        await publisher.flush();
        expect(sent).toEqual(failure === 'metadata' ? [] : ['a']);
        expect(errors).toHaveBeenCalledTimes(1);
        await expect(historyFor(metadata, ['msg_c', 'msg_a']).reconcileHistory()).rejects.toThrow('diverged');
    });
});
