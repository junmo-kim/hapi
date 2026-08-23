import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNativeTurns, resolveRewindPlan, supportsNativeRewind } from './conversationHistory'

const CWD = '/tmp/rewind-fixture-project'

function line(entry: Record<string, unknown>): string {
    return JSON.stringify(entry)
}

function prompt(uuid: string, text: string): string {
    return line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } })
}

function toolResult(uuid: string): string {
    return line({
        type: 'user',
        uuid,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] }
    })
}

function assistant(uuid: string, text: string): string {
    return line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

function attachment(uuid: string): string {
    return line({ type: 'attachment', uuid })
}

function sidechain(uuid: string): string {
    return line({ type: 'assistant', uuid, isSidechain: true, message: { role: 'assistant', content: [] } })
}

function writeTranscript(lines: string[]): string {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'hapi-rewind-')), 'projects')
    mkdirSync(projectDir, { recursive: true })
    // getProjectPath encodes every non-alphanumeric char of the cwd as '-'
    const projectId = CWD.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(projectDir, projectId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session-a.jsonl'), lines.join('\n') + '\n')
    return projectDir
}

describe('readNativeTurns', () => {
    it('collects ordered turns from prompts and assistant entries only', () => {
        const root = writeTranscript([
            line({ type: 'queue-operation', uuid: 'q1' }),
            attachment('a0'),
            prompt('u1', 'Say ONE'),
            assistant('as1', 'ONE'),
            toolResult('tr1'),
            prompt('u2', 'Say TWO'),
            assistant('as2', 'TWO'),
            sidechain('sc1'),
            prompt('u3', 'Say THREE')
        ])
        try {
            process.env.CLAUDE_CONFIG_DIR = root.replace(/\/projects$/, '')
            expect(readNativeTurns(CWD, 'session-a')).toEqual([
                { promptUuid: 'u1', endUuid: 'as1' },
                { promptUuid: 'u2', endUuid: 'as2' },
                { promptUuid: 'u3', endUuid: 'u3' }
            ])
        } finally {
            delete process.env.CLAUDE_CONFIG_DIR
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('returns empty for a missing transcript', () => {
        process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'hapi-rewind-missing-config')
        try {
            expect(readNativeTurns('/nonexistent-cwd', 'nope')).toEqual([])
        } finally {
            delete process.env.CLAUDE_CONFIG_DIR
        }
    })
})

describe('supportsNativeRewind', () => {
    it('accepts versions at or above 2.1.223', () => {
        expect(supportsNativeRewind('2.1.240 (Claude Code)')).toBe(true)
        expect(supportsNativeRewind('2.2.0 (Claude Code)')).toBe(true)
        expect(supportsNativeRewind('3.0.1')).toBe(true)
        expect(supportsNativeRewind('2.1.223 (Claude Code)')).toBe(true)
    })

    it('rejects older and undetectable binaries', () => {
        expect(supportsNativeRewind('2.1.222 (Claude Code)')).toBe(false)
        expect(supportsNativeRewind('2.0.55')).toBe(false)
        expect(supportsNativeRewind(null)).toBe(false)
        expect(supportsNativeRewind('Claude Code')).toBe(false)
    })
})

describe('resolveRewindPlan', () => {
    const turns = [
        { promptUuid: 'u1', endUuid: 'as1' },
        { promptUuid: 'u2', endUuid: 'as2' },
        { promptUuid: 'u3', endUuid: 'as3' }
    ]

    it('keeps the previous turn boundary and drops the selected turn onward', () => {
        expect(resolveRewindPlan(turns, 1)).toEqual({
            resumeSessionAt: 'as1',
            dropsTurns: ['u2', 'u3']
        })
    })

    it('rejects dropping the first turn and out-of-range indexes', () => {
        expect(() => resolveRewindPlan(turns, 0)).toThrow('Cannot rewind the first message')
        expect(() => resolveRewindPlan(turns, 3)).toThrow('no native history')
    })
})
