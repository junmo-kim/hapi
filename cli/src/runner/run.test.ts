import { describe, expect, it } from 'vitest'
import { canDelegateToWorker } from './run'
import type { SpawnSessionOptions } from '@/modules/common/rpcTypes'

describe('canDelegateToWorker', () => {
    const base: SpawnSessionOptions = { directory: '/tmp/test' }

    it('delegates simple sessions', () => {
        expect(canDelegateToWorker(base)).toBe(true)
    })

    it('delegates sessions with agent and model', () => {
        expect(canDelegateToWorker({ ...base, agent: 'gemini', model: 'gemini-2.5-pro' })).toBe(true)
    })

    it('rejects worktree sessions', () => {
        expect(canDelegateToWorker({ ...base, sessionType: 'worktree' })).toBe(false)
    })

    it('rejects resume sessions', () => {
        expect(canDelegateToWorker({ ...base, resumeSessionId: 'session-123' })).toBe(false)
    })

    it('rejects token-based sessions', () => {
        expect(canDelegateToWorker({ ...base, token: 'oauth-token' })).toBe(false)
    })

    it('delegates yolo sessions', () => {
        expect(canDelegateToWorker({ ...base, yolo: true })).toBe(true)
    })
})
