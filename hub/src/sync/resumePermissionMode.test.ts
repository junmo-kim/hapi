import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

describe('resume preserves permission mode', () => {
    it('passes the cached permissionMode when respawning a resumed session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-permission-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            // Simulate keepalive that sets permissionMode to 'bypassPermissions'
            engine.handleSessionAlive({
                sid: session.id,
                time: Date.now(),
                thinking: false,
                permissionMode: 'bypassPermissions'
            })

            // Verify the permissionMode was cached
            const cached = (engine as any).sessionCache.getSession(session.id)
            expect(cached?.permissionMode).toBe('bypassPermissions')

            // Mark session as inactive so resumeSession doesn't short-circuit
            engine.handleSessionEnd({ sid: session.id, time: Date.now() })

            let capturedPermissionMode: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                permissionMode?: string
            ) => {
                capturedPermissionMode = permissionMode
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedPermissionMode).toBe('bypassPermissions')
        } finally {
            engine.stop()
        }
    })

    it('broadcasts permissionMode changes via keepalive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-permission-broadcast',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )

        events.length = 0
        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            permissionMode: 'acceptEdits'
        })

        expect(cache.getSession(session.id)?.permissionMode).toBe('acceptEdits')

        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (update && update.type === 'session-updated') {
            expect(update.data).toEqual(expect.objectContaining({ permissionMode: 'acceptEdits' }))
        }
    })
})
