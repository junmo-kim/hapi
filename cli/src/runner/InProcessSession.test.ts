import { describe, expect, it, vi } from 'vitest'
import { InProcessSession } from './InProcessSession'

// Mock bootstrapSession to return fake session objects
vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn().mockResolvedValue({
        session: {
            updateAgentState: vi.fn(),
            onUserMessage: vi.fn(),
            keepAlive: vi.fn(),
            sendSessionEvent: vi.fn(),
            sendSessionDeath: vi.fn(),
            sendAgentMessage: vi.fn(),
            flush: vi.fn().mockResolvedValue(undefined),
            close: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
        },
        sessionInfo: {
            id: 'test-session-id',
            permissionMode: 'default',
        },
    }),
    buildMachineMetadata: vi.fn().mockReturnValue({}),
}))

// Mock the agent loop to resolve immediately (or hang until aborted)
vi.mock('@/agent/runners/runAgentSession', () => ({
    runAgentSessionWithDeps: vi.fn().mockImplementation(async (deps: any) => {
        if (deps.abortSignal) {
            await new Promise<void>((resolve) => {
                if (deps.abortSignal.aborted) return resolve()
                deps.abortSignal.addEventListener('abort', () => resolve(), { once: true })
            })
        }
    }),
}))

describe('InProcessSession', () => {
    const fakeApi = {} as any

    it('starts and returns a session ID', async () => {
        const session = new InProcessSession({
            api: fakeApi,
            machineId: 'machine-1',
            spawnOptions: { directory: '/tmp/test' },
        })

        const sessionId = await session.start()
        expect(sessionId).toBe('test-session-id')
        expect(session.running).toBe(true)
    })

    it('stops gracefully via abort signal', async () => {
        const session = new InProcessSession({
            api: fakeApi,
            machineId: 'machine-1',
            spawnOptions: { directory: '/tmp/test' },
        })

        await session.start()
        expect(session.running).toBe(true)

        await session.stop()
        expect(session.running).toBe(false)
    })

    it('stop() is safe to call when not started', async () => {
        const session = new InProcessSession({
            api: fakeApi,
            machineId: 'machine-1',
            spawnOptions: { directory: '/tmp/test' },
        })

        // Should not throw
        await session.stop()
        expect(session.running).toBe(false)
    })

    it('stop() is safe to call multiple times', async () => {
        const session = new InProcessSession({
            api: fakeApi,
            machineId: 'machine-1',
            spawnOptions: { directory: '/tmp/test' },
        })

        await session.start()
        await session.stop()
        await session.stop() // Second call should be no-op
        expect(session.running).toBe(false)
    })
})
