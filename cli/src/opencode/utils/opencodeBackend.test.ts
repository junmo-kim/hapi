import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructorCalls: Array<{ command: string; args?: string[]; env?: Record<string, string> }> = [];
const spawnCalls: Array<{ command: string; args?: string[] }> = [];

type FakeChild = {
    stdout: { on: (event: string, cb: (chunk: string) => void) => void };
    on: (event: string, cb: (arg?: unknown) => void) => void;
    kill: () => void;
};

let fakeSpawnImpl: ((command: string, args: string[]) => FakeChild) | null = null;

vi.mock('node:child_process', () => ({
    spawn: (command: string, args: string[]) => {
        spawnCalls.push({ command, args });
        if (!fakeSpawnImpl) {
            throw new Error('spawn not configured');
        }
        return fakeSpawnImpl(command, args);
    }
}));

function makeFakeChild(stdoutText: string, opts?: { error?: Error; noClose?: boolean }): FakeChild {
    const handlers = new Map<string, Array<(arg?: unknown) => void>>();
    const stdoutHandlers = new Map<string, Array<(chunk: string) => void>>();
    const child: FakeChild = {
        stdout: {
            on: (event, cb) => {
                const list = stdoutHandlers.get(event) ?? [];
                list.push(cb);
                stdoutHandlers.set(event, list);
            }
        },
        on: (event, cb) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
        },
        kill: () => {}
    };
    queueMicrotask(() => {
        for (const cb of stdoutHandlers.get('data') ?? []) cb(stdoutText);
        if (opts?.error) {
            for (const cb of handlers.get('error') ?? []) cb(opts.error);
        } else if (!opts?.noClose) {
            for (const cb of handlers.get('close') ?? []) cb();
        }
    });
    return child;
}

function configureSpawn(stdoutText: string, opts?: { error?: Error }): void {
    fakeSpawnImpl = () => makeFakeChild(stdoutText, opts);
}

vi.mock('@/agent/backends/acp', () => ({
    AcpSdkBackend: vi.fn().mockImplementation(function (
        this: unknown,
        opts: { command: string; args?: string[]; env?: Record<string, string> }
    ) {
        constructorCalls.push(opts);
        return { __opts: opts };
    })
}));

import { allocateFreePort, createOpencodeBackend, detectOpencodeFlavorVersion } from './opencodeBackend';

describe('detectOpencodeFlavorVersion', () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        fakeSpawnImpl = null;
    });

    it('detects v2 from "opencode v2.0.29" stdout', async () => {
        configureSpawn('opencode v2.0.29\n');
        await expect(detectOpencodeFlavorVersion('myopencode')).resolves.toBe('v2');
        expect(spawnCalls).toEqual([{ command: 'myopencode', args: ['--version'] }]);
    });

    it('detects v1 from "1.19.0" stdout', async () => {
        configureSpawn('1.19.0\n');
        await expect(detectOpencodeFlavorVersion('opencode')).resolves.toBe('v1');
    });

    it('detects v2 from "opencode 2.1.0" stdout without v prefix', async () => {
        configureSpawn('opencode 2.1.0\n');
        await expect(detectOpencodeFlavorVersion('opencode')).resolves.toBe('v2');
    });

    it('falls back to v1 when stdout is empty', async () => {
        configureSpawn('');
        await expect(detectOpencodeFlavorVersion('opencode')).resolves.toBe('v1');
    });

    it('falls back to v1 when spawn errors', async () => {
        configureSpawn('', { error: new Error('spawn failed') });
        await expect(detectOpencodeFlavorVersion('opencode')).resolves.toBe('v1');
    });
});

describe('allocateFreePort', () => {
    it('resolves a bindable loopback port number', async () => {
        const port = await allocateFreePort('127.0.0.1');
        expect(typeof port).toBe('number');
        expect(Number.isInteger(port)).toBe(true);
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThan(65536);
    });

    it('releases the port so it can be reused by a later caller', async () => {
        // Each call must close its probe socket before resolving, otherwise a
        // consumer that immediately tries to bind the returned port (e.g. the
        // spawned `opencode acp --port <port>` process) would collide with it.
        const first = await allocateFreePort('127.0.0.1');
        const second = await allocateFreePort('127.0.0.1');
        expect(typeof second).toBe('number');
        // Not asserting first !== second (OS may reuse immediately-freed ports),
        // only that a second allocation does not hang or throw EADDRINUSE.
        expect(first).toBeGreaterThan(0);
    });
});

describe('createOpencodeBackend', () => {
    beforeEach(() => {
        constructorCalls.length = 0;
    });

    it('passes --port and --hostname args when provided', () => {
        createOpencodeBackend({ cwd: '/tmp/x', port: 5555, hostname: '127.0.0.1' });
        expect(constructorCalls[0]?.args).toEqual([
            'acp', '--cwd', '/tmp/x', '--port', '5555', '--hostname', '127.0.0.1'
        ]);
    });

    it('omits --port/--hostname when not provided (backward compatible)', () => {
        createOpencodeBackend({ cwd: '/tmp/x' });
        expect(constructorCalls[0]?.args).toEqual(['acp', '--cwd', '/tmp/x']);
    });
});
