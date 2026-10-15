import { describe, expect, it, vi } from 'vitest';
import { captureCompactionMarkerSnapshot, fetchCompactionResult, readOpencodeV2ServerPassword, splitProviderModel, triggerOpencodeCompact, triggerOpencodeCompactV2 } from './opencodeCompactBridge';

// `signal` is a required field (see OpencodeCompactCallOpts's doc comment) —
// most tests below don't exercise abort behavior at all, so this is a
// signal that's simply never aborted, just satisfying the type.
const noSignal = new AbortController().signal;

describe('splitProviderModel', () => {
    it('splits a combined "provider/model" wire id on the first slash', () => {
        expect(splitProviderModel('ollama/qwen3.6:35b-a3b-q8_0-mtp')).toEqual({
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp'
        });
    });

    it('keeps everything after the first slash as the modelId (model ids may contain slashes)', () => {
        expect(splitProviderModel('openrouter/anthropic/claude-sonnet-4-5')).toEqual({
            providerId: 'openrouter',
            modelId: 'anthropic/claude-sonnet-4-5'
        });
    });

    it('returns null for null/undefined input', () => {
        expect(splitProviderModel(null)).toBeNull();
        expect(splitProviderModel(undefined)).toBeNull();
    });

    it('returns null when there is no slash', () => {
        expect(splitProviderModel('no-slash-here')).toBeNull();
    });

    it('returns null for a leading or trailing slash (empty provider or model)', () => {
        expect(splitProviderModel('/model-only')).toBeNull();
        expect(splitProviderModel('provider-only/')).toBeNull();
    });
});

describe('triggerOpencodeCompact', () => {
    it('posts to /session/:id/summarize with the required providerID/modelID payload and no artificial timeout', async () => {
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe('http://127.0.0.1:48273/session/ses_abc/summarize');
            expect(init?.method).toBe('POST');
            expect(JSON.parse(init?.body as string)).toEqual({
                providerID: 'ollama',
                modelID: 'qwen3.6:35b-a3b-q8_0-mtp'
            });
            // `signal` is always attached now (required — see
            // OpencodeCompactCallOpts), but it must not act as a deadline on
            // its own: the caller here never aborts it, so the request must
            // run to completion regardless of how long it legitimately takes
            // (90s+ verified against SER8, 2026-07-30).
            expect(init?.signal).toBe(noSignal);
            // Bun's global fetch() hardcodes a 5-minute idle timeout that
            // fires even with no AbortSignal at all (verified via isolated
            // E2E against SER8, 2026-07-30 — a real ~250s compaction call
            // failed with "The operation timed out"; see oven-sh/bun#16682).
            // The only documented workaround is this Bun-specific,
            // non-standard `timeout: false` fetch option — needed regardless
            // of whether the caller's own `signal` ever fires.
            expect((init as unknown as { timeout?: boolean })?.timeout).toBe(false);
            return new Response(null, { status: 204 });
        });

        const result = await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('reports a structured failure when the server responds non-ok (e.g. the v2 compact stub 503)', async () => {
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify({ _tag: 'ServiceUnavailableError', message: 'Session compact is not available yet', service: 'session.compact' }),
            { status: 503 }
        ));

        const result = await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: noSignal
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('503');
            expect(result.error).toContain('not available yet');
        }
    });

    it('reports a structured failure when the network call throws', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        });

        const result = await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
    });

    it('URL-encodes the sessionId in the path', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            expect(url).toBe('http://127.0.0.1:48273/session/ses%20with%20space/summarize');
            return new Response(null, { status: 204 });
        });

        await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses with space',
            providerId: 'ollama',
            modelId: 'model-x',
            fetchImpl,
            signal: noSignal
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('forwards an AbortSignal to fetch when provided, so a caller can interrupt an in-flight request', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            expect(init?.signal).toBe(controller.signal);
            return new Response(null, { status: 204 });
        });

        const result = await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: controller.signal
        });

        expect(result).toEqual({ ok: true });
    });

    it('resolves with a structured failure (not a hang or uncaught rejection) when the signal aborts mid-request', async () => {
        const controller = new AbortController();
        // Mirrors how a real fetch() rejects on abort: the promise only
        // settles once the signal actually fires, not before.
        const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
        }));

        const resultPromise = triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: controller.signal
        });

        controller.abort();
        const result = await resultPromise;

        expect(result.ok).toBe(false);
    });
});

const marker = (id: string) => ({
    info: { id, role: 'user' },
    parts: [{ type: 'compaction', auto: false }]
});

const summary = (id: string, parentID: string, overrides: Record<string, unknown> = {}, text: string | null = '## Objective\n- Did the thing') => ({
    info: { id, role: 'assistant', parentID, summary: true, finish: 'provider-terminal', ...overrides },
    parts: text === null ? [{ type: 'step-start' }, { type: 'step-finish' }] : [{ type: 'text', text }]
});

describe('captureCompactionMarkerSnapshot', () => {
    it('records only pre-existing manual marker IDs before POST so a later result cannot reuse them', async () => {
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe('http://127.0.0.1:48273/session/ses_abc/message');
            expect(init).toMatchObject({ method: 'GET', signal: noSignal });
            return new Response(JSON.stringify([marker('old-marker')]), { status: 200 });
        });

        await expect(captureCompactionMarkerSnapshot({
            baseUrl: 'http://127.0.0.1:48273', sessionId: 'ses_abc', fetchImpl, signal: noSignal
        })).resolves.toEqual({ markerIds: ['old-marker'] });
    });
});

describe('fetchCompactionResult', () => {
    const options = (messages: unknown[]) => ({
        baseUrl: 'http://127.0.0.1:48273',
        sessionId: 'ses_abc',
        markerIdsBefore: ['old-marker'],
        fetchImpl: vi.fn(async () => new Response(JSON.stringify(messages), { status: 200 })),
        signal: noSignal
    });

    it('succeeds only for the new marker\'s exactly parent-linked terminal summary with nonblank text', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            summary('old-summary', 'old-marker', {}, 'old summary'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker')
        ]));

        expect(result).toEqual({ status: 'success', text: '## Objective\n- Did the thing' });
    });

    it('does not guess between two post-snapshot manual markers', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker'),
            marker('later-manual-marker'),
            summary('later-summary', 'later-manual-marker', {}, 'later summary')
        ]));

        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('does not fall back to adjacent text when the new marker has no exact parent-linked assistant result', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('unrelated-summary', 'another-marker')
        ]));

        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('keeps a malformed result GET unverified', async () => {
        const result = await fetchCompactionResult({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            markerIdsBefore: ['old-marker'],
            fetchImpl: vi.fn(async () => new Response('not json', { status: 200 })),
            signal: noSignal
        });

        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('classifies the observed HTTP-200, finish-unknown, empty linked summary as failed', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker', {
                finish: 'unknown',
                tokens: { input: 0, output: 0, reasoning: 0 }
            }, null)
        ]));

        expect(result).toEqual({ status: 'failed', reason: 'OpenCode returned an empty compaction summary.' });
    });

    it('does not use a finish allowlist when terminal evidence and a valid summary are present', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker', { finish: 'provider-specific-finish' })
        ]));

        expect(result).toEqual({ status: 'success', text: '## Objective\n- Did the thing' });
    });

    it('concatenates every text part from the exact linked summary', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            {
                info: {
                    id: 'this-request-summary',
                    role: 'assistant',
                    parentID: 'this-request-marker',
                    summary: true,
                    finish: 'provider-terminal'
                },
                parts: [
                    { type: 'text', text: '## Objective\n' },
                    { type: 'step-finish' },
                    { type: 'text', text: '- Did the thing' }
                ]
            }
        ]));

        expect(result).toEqual({ status: 'success', text: '## Objective\n- Did the thing' });
    });

    it('keeps an associated but non-terminal result unverified instead of treating token-less text as a failure', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker', { finish: undefined }, '')
        ]));

        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('uses OpenCode APIError.data.message as a normalized, truncated safe failure reason without serializing metadata', async () => {
        const providerMessage = ` provider\n unavailable  ${'x'.repeat(220)} `;
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker', {
                error: {
                    name: 'APIError',
                    data: {
                        message: providerMessage,
                        apiKey: 'super-secret-api-key',
                        requestHeaders: { authorization: 'Bearer super-secret-token' }
                    }
                }
            }, null)
        ]));

        expect(result).toEqual({ status: 'failed', reason: `provider unavailable ${'x'.repeat(179)}` });
        expect((result as { reason: string }).reason).not.toContain('super-secret');
    });

    it('returns unverified when the semantic-result GET is aborted', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            expect(init?.signal).toBe(controller.signal);
            init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }));

        const resultPromise = fetchCompactionResult({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            markerIdsBefore: ['old-marker'],
            fetchImpl,
            signal: controller.signal
        });
        controller.abort();

        await expect(resultPromise).resolves.toEqual({
            status: 'unverified', reason: 'Compaction result could not be verified.'
        });
    });
});

describe('triggerOpencodeCompactV2', () => {
    it('posts to /api/session/:id/compact with Basic auth and providerID/modelID body', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc/1',
            providerId: 'anthropic',
            modelId: 'claude-sonnet-4-5',
            password: 'secret-pw',
            fetchImpl
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:48273/api/session/ses_abc%2F1/compact');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>).authorization)
            .toBe('Basic ' + Buffer.from('opencode:secret-pw').toString('base64'));
        expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
        expect(JSON.parse(String(init.body))).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' });
    });

    it('encodes the Basic credentials from the OPENCODE_PASSWORD value', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'user:pass@with/special',
            fetchImpl
        });
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect((init.headers as Record<string, string>).authorization)
            .toBe('Basic ' + Buffer.from('opencode:user:pass@with/special').toString('base64'));
    });

    it('throws an Error including status and body on non-2xx responses', async () => {
        const fetchImpl = vi.fn(async () => new Response('denied', { status: 401 }));
        await expect(triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'pw',
            fetchImpl
        })).rejects.toThrow(/401/);
        await expect(triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'pw',
            fetchImpl
        })).rejects.toThrow(/denied/);
    });

    it('propagates fetch failures as errors', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('connection refused');
        });
        await expect(triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'pw',
            fetchImpl
        })).rejects.toThrow('connection refused');
    });
});

describe('readOpencodeV2ServerPassword', () => {
    it('extracts OPENCODE_PASSWORD from a parsed /proc environ payload (linux)', async () => {
        const environ = 'PATH=/usr/bin\0HOME=/home/u\0OPENCODE_PASSWORD=abc123\0TERM=xterm\0';
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'linux',
            listChildPids: async () => [5150],
            readChildEnviron: async () => environ
        });
        expect(password).toBe('abc123');
    });

    it('returns null when the environ payload has no OPENCODE_PASSWORD', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'linux',
            listChildPids: async () => [5150],
            readChildEnviron: async () => 'PATH=/usr/bin\0HOME=/home/u\0'
        });
        expect(password).toBeNull();
    });

    it('returns null when environ parsing fails (read error)', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'linux',
            listChildPids: async () => [5150],
            readChildEnviron: async () => {
                throw new Error('ENOENT');
            }
        });
        expect(password).toBeNull();
    });

    it('extracts OPENCODE_PASSWORD from ps Eww output on non-linux platforms', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'darwin',
            execImpl: async (command, args) => {
                if (command === 'pgrep') {
                    expect(args).toEqual(['-P', '4242']);
                    return '5150\n';
                }
                expect(command).toBe('ps');
                expect(args).toEqual(['Eww', '-p', '5150']);
                return '  PID TTY      STAT   TIME COMMAND\n  5150 ?      Ss     0:00 /bin/opencode serve --stdio OPENCODE_PASSWORD=darwin-pw PATH=/usr/bin';
            }
        });
        expect(password).toBe('darwin-pw');
    });

    it('returns null when pgrep/ps path yields nothing', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'darwin',
            execImpl: async () => {
                throw new Error('no such process');
            }
        });
        expect(password).toBeNull();
    });
});
