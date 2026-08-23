import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type {
    OpencodeImportedMessage,
    OpencodeImportedMessageContent,
    OpencodeLocalSessionSummary,
    OpencodeLocalSessionWithMessages
} from '@hapi/protocol/apiTypes'

const DEFAULT_OPENCODE_SESSION_SCAN_LIMIT = 200
const LAST_USER_MESSAGE_MAX_LENGTH = 140

type JsonRecord = Record<string, unknown>

type SqlParams = unknown[]

type StatementLike = {
    get: (...params: SqlParams) => unknown
    all: (...params: SqlParams) => unknown[]
}

type DatabaseLike = {
    query: (sql: string) => StatementLike
    close: () => void
}

export type OpencodeDatabaseOpener = (dbPath: string) => Promise<DatabaseLike | null>

type SessionRow = {
    id: string
    title: string | null
    directory: string | null
    time_updated: number | string
}

let cachedOpener: OpencodeDatabaseOpener | null = null

async function getDefaultOpener(): Promise<OpencodeDatabaseOpener> {
    if (!cachedOpener) {
        cachedOpener = async (dbPath: string) => {
            try {
                const { Database } = await import('bun:sqlite')
                if (!existsSync(dbPath)) return null
                return new Database(dbPath, { readonly: true }) as unknown as DatabaseLike
            } catch {
                return null
            }
        }
    }
    return cachedOpener
}

function asRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
}

export function getOpencodeSessionsRoot(overrideRoot?: string): string {
    const direct = overrideRoot ?? process.env.OPENCODE_HOME?.trim()
    if (direct) return direct
    const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
    return join(dataHome, 'opencode')
}

export function getOpencodeDbPath(overrideRoot?: string): string {
    return join(getOpencodeSessionsRoot(overrideRoot), 'opencode.db')
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

async function openDb(dbPath: string, opener?: OpencodeDatabaseOpener): Promise<DatabaseLike | null> {
    const resolveOpener = opener ?? await getDefaultOpener()
    try {
        return await resolveOpener(dbPath)
    } catch {
        return null
    }
}

function hasRequiredTables(db: DatabaseLike): boolean {
    for (const table of ['session', 'message', 'part']) {
        try {
            const row = db.query(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
            ).get(table) as { name: string } | null | undefined
            if (!row?.name) return false
        } catch {
            return false
        }
    }
    return true
}

function parseJson(value: unknown): JsonRecord | null {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
        return asRecord(JSON.parse(value))
    } catch {
        return null
    }
}

function collectTextParts(db: DatabaseLike, messageId: string): string[] {
    let partRows: Array<{ data: unknown }> = []
    try {
        partRows = db.query(
            `SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC`
        ).all(messageId) as Array<{ data: unknown }>
    } catch {
        return []
    }
    const texts: string[] = []
    for (const partRow of partRows) {
        const parsed = parseJson(partRow.data)
        if (parsed?.type !== 'text' || typeof parsed.text !== 'string') continue
        if (!parsed.text.trim()) continue
        texts.push(parsed.text)
    }
    return texts
}

function extractLastUserMessage(db: DatabaseLike, sessionId: string): string | null {
    let messageRows: Array<{ id: string; data: unknown }> = []
    try {
        messageRows = db.query(
            `SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC`
        ).all(sessionId) as Array<{ id: string; data: unknown }>
    } catch {
        return null
    }
    for (const messageRow of messageRows) {
        const parsed = parseJson(messageRow.data)
        if (parsed?.role !== 'user') continue
        const text = collectTextParts(db, messageRow.id)
            .filter((part) => !part.startsWith('<'))
            .join('')
            .trim()
        if (!text) continue
        return truncateText(text, LAST_USER_MESSAGE_MAX_LENGTH)
    }
    return null
}

function importedUser(text: string): OpencodeImportedMessageContent {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: { sentFrom: 'cli' }
    }
}

function importedAgent(text: string): OpencodeImportedMessageContent {
    return {
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: text, id: randomUUID() } },
        meta: { sentFrom: 'cli' }
    }
}

function normalizeTimestamp(value: number | string | null | undefined, fallback: number): number {
    const timestamp = Number(value)
    if (!Number.isFinite(timestamp)) return fallback
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
}

async function buildSessionMessages(
    db: DatabaseLike,
    summary: OpencodeLocalSessionSummary
): Promise<OpencodeLocalSessionWithMessages> {
    const messages: OpencodeImportedMessage[] = []
    let createdAt = summary.modifiedAt
    try {
        const messageRows = db.query(
            `SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC`
        ).all(summary.id) as Array<{ id: string; data: unknown; time_created: number | string }>
        for (const messageRow of messageRows) {
            const parsed = parseJson(messageRow.data)
            const role = typeof parsed?.role === 'string' ? parsed.role : null
            if (!role) continue
            createdAt = normalizeTimestamp(messageRow.time_created, createdAt)
            for (const text of collectTextParts(db, messageRow.id)) {
                messages.push({
                    localId: `opencode:${summary.id}:${messageRow.id}:${randomUUID()}`,
                    createdAt,
                    content: role === 'user' ? importedUser(text) : importedAgent(text)
                })
            }
        }
    } catch {
        // fall through with whatever was collected
    }
    return { ...summary, messages }
}

export async function listLocalOpencodeSessionSummaries(
    limit = DEFAULT_OPENCODE_SESSION_SCAN_LIMIT,
    opener?: OpencodeDatabaseOpener
): Promise<OpencodeLocalSessionSummary[]> {
    if (limit <= 0) return []
    const dbPath = getOpencodeDbPath()
    const db = await openDb(dbPath, opener)
    if (!db) return []
    try {
        if (!hasRequiredTables(db)) return []
        let rows: SessionRow[] = []
        try {
            rows = db.query(
                `SELECT id, title, directory, time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?`
            ).all(limit) as SessionRow[]
        } catch {
            return []
        }
        return rows.map((row) => ({
            id: row.id,
            title: row.title ?? '',
            lastUserMessage: extractLastUserMessage(db, row.id),
            cwd: row.directory ?? null,
            file: dbPath,
            modifiedAt: Number(row.time_updated)
        }))
    } finally {
        db.close()
    }
}

export async function listLocalOpencodeSessionsWithMessagesByIds(
    ids: Set<string>,
    opener?: OpencodeDatabaseOpener
): Promise<OpencodeLocalSessionWithMessages[]> {
    if (ids.size === 0) return []
    const dbPath = getOpencodeDbPath()
    const db = await openDb(dbPath, opener)
    if (!db) return []
    try {
        if (!hasRequiredTables(db)) return []
        const sessions: OpencodeLocalSessionWithMessages[] = []
        for (const id of ids) {
            let rows: SessionRow[] = []
            try {
                rows = db.query(
                    `SELECT id, title, directory, time_updated FROM session WHERE id = ?`
                ).all(id) as SessionRow[]
            } catch {
                continue
            }
            const row = rows[0]
            if (!row) continue
            const summary: OpencodeLocalSessionSummary = {
                id: row.id,
                title: row.title ?? '',
                lastUserMessage: extractLastUserMessage(db, row.id),
                cwd: row.directory ?? null,
                file: dbPath,
                modifiedAt: Number(row.time_updated)
            }
            sessions.push(await buildSessionMessages(db, summary))
        }
        // same ordering semantics as summaries: modifiedAt desc
        return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
    } finally {
        db.close()
    }
}
