import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('Codex conversation-history hub integration', () => {
    it('stores child-side fork intent while spawning from the source thread', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const source = engine.getOrCreateSession('codex-source', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex',
                codexSessionId: 'thread-source', capabilities: { conversationHistory: { forkCurrent: true } }
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(source.id, { role: 'user', content: 'source transcript' }, 'local-1')
            store.messages.markMessagesInvoked(source.id, ['local-1'], Date.now())
            ;(engine as any).rpcGateway.forkConversation = async () => ({
                nativeSessionId: 'thread-source',
                codexForkRequest: { sourceThreadId: 'thread-source' }
            })
            let spawnArgs: unknown[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnArgs = args
                return { type: 'success', sessionId: args[12] }
            }
            const waitCalls: unknown[][] = []
            ;(engine as any).waitForCodexForkBound = async (...args: unknown[]) => {
                waitCalls.push(args)
                return true
            }

            const result = await engine.forkConversation(source.id, 'default')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            expect(engine.getSession(result.sessionId)?.metadata).toMatchObject({
                codexSessionId: 'thread-source',
                codexForkRequest: { sourceThreadId: 'thread-source' }
            })
            expect(spawnArgs[8]).toBe('thread-source')
            expect(waitCalls).toEqual([[result.sessionId, 'thread-source']])
            expect(store.messages.getAllMessages(result.sessionId).map((message) => message.localId)).toEqual(['local-1'])
        } finally {
            engine.stop()
        }
    })

    for (const [name, rpcResult] of [
        ['missing request', { nativeSessionId: 'thread-source' }],
        ['mismatched source id', { nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'other' } }],
        ['conflicting boundaries', {
            nativeSessionId: 'thread-source',
            codexForkRequest: { sourceThreadId: 'thread-source', lastTurnId: 'a', beforeTurnId: 'b' }
        }]
    ] as const) {
        it(`fails closed for ${name}`, async () => {
            const store = new Store(':memory:')
            const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            try {
                const source = engine.getOrCreateSession(`codex-${name}`, {
                    path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex',
                    codexSessionId: 'thread-source', capabilities: { conversationHistory: { forkCurrent: true } }
                }, null, 'default')
                engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
                ;(engine as any).rpcGateway.forkConversation = async () => rpcResult
                let spawnCalls = 0
                ;(engine as any).rpcGateway.spawnSession = async () => {
                    spawnCalls += 1
                    return { type: 'success', sessionId: 'unexpected' }
                }

                expect((await engine.forkConversation(source.id, 'default')).type).toBe('error')
                expect(spawnCalls).toBe(0)
            } finally {
                engine.stop()
            }
        })
    }

    it('rejects Codex fork intent returned for another flavor', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const source = engine.getOrCreateSession('grok-source', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'grok',
                capabilities: { conversationHistory: { forkCurrent: true } }
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            ;(engine as any).rpcGateway.forkConversation = async () => ({
                nativeSessionId: 'grok-fork', codexForkRequest: { sourceThreadId: 'grok-fork' }
            })

            expect((await engine.forkConversation(source.id, 'default')).type).toBe('error')
        } finally {
            engine.stop()
        }
    })

    it('accepts only a distinct Codex id with the pending request removed', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const success = engine.getOrCreateSession('codex-bound', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-child'
            }, null, 'default')
            const pending = engine.getOrCreateSession('codex-pending', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-child',
                codexForkRequest: { sourceThreadId: 'thread-source' }
            }, null, 'default')
            const same = engine.getOrCreateSession('codex-same', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-source'
            }, null, 'default')
            engine.handleSessionAlive({ sid: success.id, time: Date.now(), mode: 'remote' })
            engine.handleSessionAlive({ sid: pending.id, time: Date.now(), mode: 'remote' })

            expect(await (engine as any).waitForCodexForkBound(success.id, 'thread-source', 5)).toBe(true)
            expect(await (engine as any).waitForCodexForkBound(pending.id, 'thread-source', 5)).toBe(false)
            expect(await (engine as any).waitForCodexForkBound(same.id, 'thread-source', 5)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('returns false when the Codex fork child becomes inactive', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const child = engine.getOrCreateSession('codex-inactive', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-source',
                codexForkRequest: { sourceThreadId: 'thread-source' }
            }, null, 'default')
            expect(await (engine as any).waitForCodexForkBound(child.id, 'thread-source', 5)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('cleans up the child when Codex materialization does not bind', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const source = engine.getOrCreateSession('codex-cleanup-source', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex',
                codexSessionId: 'thread-source', capabilities: { conversationHistory: { forkCurrent: true } }
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            ;(engine as any).rpcGateway.forkConversation = async () => ({
                nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' }
            })
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => ({ type: 'success', sessionId: args[12] })
            ;(engine as any).waitForCodexForkBound = async () => false
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'

            const result = await engine.forkConversation(source.id, 'default')
            expect(result).toEqual({ type: 'error', message: 'Codex fork did not materialize before timeout' })
            expect(engine.getSessions().filter((session) => session.metadata?.forkedFrom === source.id)).toEqual([])
        } finally {
            engine.stop()
        }
    })
})
