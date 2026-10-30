import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpencodeNativeTranscript } from './opencodeNativeTranscript';

function setup(fetchImpl = vi.fn(async () => Response.json([]))) {
    const onSummary = vi.fn();
    const onText = vi.fn();
    const onReadFailure = vi.fn();
    const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v1', fetchImpl: fetchImpl, onSummary, onText, onReadFailure });
    return { transcript, onSummary, onText, onReadFailure, fetchImpl };
}

describe('OpenCode native transcript reconciliation', () => {
    afterEach(() => vi.useRealTimers());
    it('primes historical text without replay, then retains deltas after a snapshot and flushes terminal text', async () => {
        const fetchImpl = vi.fn(async () => Response.json([{ info: { id: 'answer', sessionID: 'ses', role: 'assistant' }, parts: [{ id: 'part', messageID: 'answer', sessionID: 'ses', type: 'text', text: 'old' }] }]));
        const { transcript, onText } = setup(fetchImpl);
        await transcript.refresh();
        expect(onText).not.toHaveBeenCalled();
        transcript.event('message.part.delta', { partID: 'part', field: 'text', delta: ' new' });
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'old new', complete: false }));
        transcript.close();
    });
    it('drops a stale read and honors an idle/reconnect refresh requested while it was in flight', async () => {
        let resolve!: (r: Response) => void;
        const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; })).mockResolvedValue(Response.json([]));
        const { transcript, onText } = setup(fetchImpl);
        const first = transcript.refresh();
        transcript.event('message.updated', { info: { id: 'answer', sessionID: 'ses', role: 'assistant' } });
        transcript.event('message.part.updated', { part: { id: 'part', sessionID: 'ses', messageID: 'answer', type: 'text', text: 'new' } });
        void transcript.refresh();
        resolve(Response.json([{ info: { id: 'answer', sessionID: 'ses', role: 'assistant' }, parts: [{ id: 'part', sessionID: 'ses', messageID: 'answer', type: 'text', text: 'stale' }] }]));
        await first;
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(onText.mock.calls.some(c => c[0].text === 'stale')).toBe(false);
        transcript.close();
    });
    it('scopes v2 records from the session read route and ignores explicitly foreign entries', async () => {
        const onSummary = vi.fn();
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v2', headers: { authorization: 'synthetic' }, onText: vi.fn(), onSummary,
            fetchImpl: vi.fn(async () => Response.json({ data: [
                { id: 'auto', type: 'compaction', status: 'completed', reason: 'auto', summary: 'Native summary' },
                { id: 'child', sessionID: 'child', type: 'compaction', status: 'completed', summary: 'Foreign' }
            ] })) });
        await transcript.refresh();
        await transcript.refresh();
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('auto', 'Native summary', 'auto');
        transcript.close();
    });
    it('reports read failure once, retries, and suppresses late data after cleanup', async () => {
        const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
        const { transcript, onSummary, onReadFailure } = setup(fetchImpl);
        await transcript.refresh(); await transcript.refresh();
        expect(onReadFailure).toHaveBeenCalledOnce();
        transcript.close();
        await transcript.refresh();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(onSummary).not.toHaveBeenCalled();
    });
    it('reads every v2 compaction page in chronological order before projection', async () => {
        const onSummary = vi.fn();
        const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'old', type: 'compaction', status: 'completed', reason: 'auto', summary: 'old' }], cursor: { next: 'opaque' } }))
            .mockResolvedValueOnce(Response.json({ data: [{ id: 'new', type: 'compaction', status: 'completed', reason: 'auto', summary: 'new' }], cursor: { next: null } }));
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v2', fetchImpl, onText: vi.fn(), onSummary });
        await transcript.refresh();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][0]).toContain('type=compaction');
        expect(fetchImpl.mock.calls[0][0]).toContain('order=asc');
        expect(fetchImpl.mock.calls[1][0]).toContain('cursor=opaque');
        expect(fetchImpl.mock.calls[1][0]).not.toContain('order=');
        expect(onSummary.mock.calls.map(c => c[0])).toEqual(['old', 'new']);
        transcript.close();
    });
    it('bounds cumulative stream emissions and always delivers the final snapshot', async () => {
        vi.useFakeTimers();
        const { transcript, onText } = setup();
        await transcript.refresh();
        transcript.event('message.updated', { info: { id: 'answer', sessionID: 'ses', role: 'assistant' } });
        for (let i = 1; i <= 100; i++) transcript.event('message.part.updated', { part: { id: 'part', messageID: 'answer', sessionID: 'ses', type: 'text', text: 'x'.repeat(i) } });
        expect(onText).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(120);
        expect(onText).toHaveBeenCalledTimes(2);
        transcript.event('message.part.updated', { part: { id: 'part', messageID: 'answer', sessionID: 'ses', type: 'text', text: 'Final', time: { end: 1 } } });
        expect(onText).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Final', complete: true }));
        transcript.close();
        await vi.runAllTimersAsync();
        expect(onText).toHaveBeenCalledTimes(3);
    });

});


describe('v2 durable application start', () => {
    it('keeps the start identity across fast completion and running snapshot replay without observing preparation usage', async () => {
        const onStart = vi.fn(), onSummary = vi.fn();
        const fetchImpl = vi.fn(async () => Response.json({ data: [{ id: 'msg_apply', type: 'compaction', status: 'completed', reason: 'auto', summary: 'Installed summary' }] }));
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v2', fetchImpl, onText: vi.fn(), onStart, onSummary });
        transcript.event('session.usage.recorded', { sessionID: 'ses', source: 'compaction', tokens: { input: 100, output: 20 } }, 'evt_prepare_usage');
        transcript.event('session.compaction.started', { sessionID: 'other', reason: 'auto' }, 'evt_foreign');
        expect(onStart).not.toHaveBeenCalled();
        transcript.event('session.compaction.started', { sessionID: 'ses', reason: 'auto' }, 'evt_apply');
        transcript.event('session.compaction.started', { sessionID: 'ses', reason: 'auto' }, 'evt_apply');
        await transcript.refresh();
        expect(onStart).toHaveBeenCalledExactlyOnceWith('msg_apply', 'auto');
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('msg_apply', 'Installed summary', 'auto');
        transcript.close();
        transcript.event('session.compaction.started', { sessionID: 'ses', reason: 'auto' }, 'evt_late');
        expect(onStart).toHaveBeenCalledTimes(1);
    });
});
