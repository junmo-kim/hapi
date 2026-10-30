import { describe, expect, it, vi } from 'vitest';
import { OpencodeCompactionProjector } from './opencodeCompactionProjector';

const marker = { id: 'marker', sessionID: 'ses', role: 'user' };
const summary = { id: 'summary', sessionID: 'ses', role: 'assistant', parentID: 'marker', summary: true, finish: 'stop' };
const text = { id: 'part', sessionID: 'ses', messageID: 'summary', type: 'text', text: 'Checkpoint', time: { end: 1 } };
function setup() {
    const onSummary = vi.fn();
    const onText = vi.fn();
    return { onSummary, onText, projector: new OpencodeCompactionProjector({ sessionId: 'ses', onSummary, onText }) };
}
describe('OpenCode native compaction projection', () => {
    it('holds summary text, validates its parent, and emits one stable card across replay', () => {
        const { projector, onSummary, onText } = setup();
        projector.message(summary);
        projector.part(text);
        expect(onSummary).not.toHaveBeenCalled();
        expect(onText).not.toHaveBeenCalled();
        projector.message(marker);
        projector.part({ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true });
        projector.part(text);
        projector.message(summary);
        projector.flush();
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('marker', 'Checkpoint', 'auto');
    });
    it.each([
        { state: 'incomplete', info: { ...summary, finish: undefined } },
        { state: 'failed', info: { ...summary, error: { message: 'failed' } } },
        { state: 'foreign', info: { ...summary, sessionID: 'child' } },
        { state: 'unlinked', info: { ...summary, parentID: 'other' } }
    ])('does not turn an $state summary into success', ({ info }) => {
        const { projector, onSummary } = setup();
        projector.message(marker);
        projector.part({ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true });
        projector.message(info);
        projector.part(text);
        projector.flush();
        expect(onSummary).not.toHaveBeenCalled();
    });
    it('preserves identical real prompts and unrelated synthetic text, hiding only native continuation metadata', () => {
        const { projector, onText } = setup();
        projector.message({ id: 'u', sessionID: 'ses', role: 'user' });
        for (const [id, extra] of [['real', {}], ['synthetic', { synthetic: true }], ['control', { synthetic: true, metadata: { compaction_continue: true } }]] as const) {
            projector.part({ id, messageID: 'u', sessionID: 'ses', type: 'text', text: 'Continue if you have next steps', ...extra });
        }
        expect(onText.mock.calls.map(c => c[0].id)).toEqual(['real', 'synthetic']);
    });
    it('holds parts arriving before metadata and preserves the real response after compaction', () => {
        const { projector, onText } = setup();
        projector.part({ ...text, messageID: 'answer', id: 'answer-part', text: 'Next answer' });
        expect(onText).not.toHaveBeenCalled();
        projector.message({ id: 'answer', sessionID: 'ses', role: 'assistant' });
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Next answer', role: 'assistant' }));
    });
    it('accepts v2 completed checkpoints, including native windows, but never fabricates empty success', () => {
        const { projector, onSummary } = setup();
        projector.message({ id: 'v2', sessionID: 'ses', type: 'compaction', status: 'running', summary: 'partial' });
        projector.message({ id: 'failed', sessionID: 'ses', type: 'compaction', status: 'failed', summary: 'partial' });
        projector.message({ id: 'empty', sessionID: 'ses', type: 'compaction', status: 'completed', summary: '' });
        projector.message({ id: 'v2', sessionID: 'ses', type: 'compaction', status: 'completed', summary: 'Done' });
        projector.message({ id: 'native', sessionID: 'ses', type: 'compaction', status: 'completed', summary: '', native: { messages: [{ role: 'user', content: 'input' }] } });
        projector.flush();
        expect(onSummary.mock.calls).toEqual([['v2', 'Done', undefined], ['native', '', undefined]]);
    });
    it('keeps visible synthetic assistant output without an end time and honors ignored metadata', () => {
        const { projector, onText } = setup();
        projector.message({ id: 'answer', sessionID: 'ses', role: 'assistant' });
        projector.part({ ...text, id: 'visible', messageID: 'answer', synthetic: true, time: undefined });
        projector.part({ ...text, id: 'ignored', messageID: 'answer', ignored: true });
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'visible', complete: true }));
    });
    it('settles a complete multipart summary once at the storage scan boundary', () => {
        const { projector, onSummary } = setup();
        projector.message(marker);
        projector.part({ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: false });
        projector.message(summary);
        projector.part({ ...text, text: 'First' });
        projector.part({ ...text, id: 'part-2', text: 'Second' });
        expect(onSummary).not.toHaveBeenCalled();
        projector.flush();
        projector.flush();
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('marker', 'First\n\nSecond', 'manual');
    });

    it('retains a failed summary until its missed automatic marker is classified', () => {
        const onFailure = vi.fn();
        const projector = new OpencodeCompactionProjector({ sessionId: 'ses', onSummary: vi.fn(), onFailure });
        projector.message({ ...summary, error: { message: 'failed' } });
        projector.flush();
        expect(onFailure).not.toHaveBeenCalled();
        projector.message(marker);
        projector.part({ id: 'marker-part', sessionID: 'ses', messageID: 'marker', type: 'compaction', auto: true });
        projector.flush();
        projector.flush();
        expect(onFailure).toHaveBeenCalledExactlyOnceWith('marker', 'auto');
    });

});
