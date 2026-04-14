import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSessionMetadata } from './sessionFactory'

describe('buildSessionMetadata', () => {
    const originalHostname = process.env.HAPI_HOSTNAME

    afterEach(() => {
        if (originalHostname === undefined) {
            delete process.env.HAPI_HOSTNAME
        } else {
            process.env.HAPI_HOSTNAME = originalHostname
        }
    })

    it('uses HAPI_HOSTNAME for session metadata host when provided', () => {
        process.env.HAPI_HOSTNAME = 'custom-session-host'

        const metadata = buildSessionMetadata({
            flavor: 'codex',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            now: 123
        })

        expect(metadata.host).toBe('custom-session-host')
    })
})

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn().mockResolvedValue({
            getOrCreateMachine: vi.fn().mockResolvedValue({}),
            getOrCreateSession: vi.fn().mockResolvedValue({
                id: 'session-1',
                tag: 'tag-1',
                permissionMode: 'default',
            }),
            sessionSyncClient: vi.fn().mockReturnValue({
                updateAgentState: vi.fn(),
            }),
        }),
    },
}))

vi.mock('@/persistence', () => ({
    readSettings: vi.fn().mockResolvedValue({ machineId: 'default-machine-id' }),
}))

vi.mock('@/runner/controlClient', () => ({
    notifyRunnerSessionStarted: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/utils/invokedCwd', () => ({
    getInvokedCwd: vi.fn().mockReturnValue('/tmp/test-cwd'),
}))

describe('bootstrapSession', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('skips ApiClient.create() when existingApi is provided', async () => {
        const { bootstrapSession } = await import('./sessionFactory')
        const { ApiClient } = await import('@/api/api')

        const fakeApi = {
            getOrCreateMachine: vi.fn().mockResolvedValue({}),
            getOrCreateSession: vi.fn().mockResolvedValue({
                id: 'session-1',
                tag: 'tag-1',
                permissionMode: 'default',
            }),
            sessionSyncClient: vi.fn().mockReturnValue({}),
        }

        await bootstrapSession({
            flavor: 'claude',
            startedBy: 'runner',
            workingDirectory: '/tmp/test',
            existingApi: fakeApi as any,
        })

        expect(ApiClient.create).not.toHaveBeenCalled()
        // machine registration still happens because existingMachineId is not provided
        expect(fakeApi.getOrCreateMachine).toHaveBeenCalled()
    })

    it('skips getMachineIdOrExit() when existingMachineId is provided', async () => {
        const { bootstrapSession } = await import('./sessionFactory')
        const { readSettings } = await import('@/persistence')

        await bootstrapSession({
            flavor: 'claude',
            startedBy: 'runner',
            workingDirectory: '/tmp/test',
            existingMachineId: 'pre-created-machine-id',
        })

        expect(readSettings).not.toHaveBeenCalled()
    })

    it('skips machine registration when both existingApi and existingMachineId are provided', async () => {
        const { bootstrapSession } = await import('./sessionFactory')
        const { ApiClient } = await import('@/api/api')

        const fakeApi = {
            getOrCreateMachine: vi.fn().mockResolvedValue({}),
            getOrCreateSession: vi.fn().mockResolvedValue({
                id: 'session-1',
                tag: 'tag-1',
                permissionMode: 'default',
            }),
            sessionSyncClient: vi.fn().mockReturnValue({}),
        }

        await bootstrapSession({
            flavor: 'claude',
            startedBy: 'runner',
            workingDirectory: '/tmp/test',
            existingApi: fakeApi as any,
            existingMachineId: 'pre-created-machine-id',
        })

        expect(ApiClient.create).not.toHaveBeenCalled()
        expect(fakeApi.getOrCreateMachine).not.toHaveBeenCalled()
    })
})
