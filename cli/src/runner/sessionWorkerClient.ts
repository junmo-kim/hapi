/**
 * Client for communicating with the Session Worker process.
 * Used by the Runner to create/stop sessions via localhost HTTP.
 * Pattern follows controlClient.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { isProcessAlive } from '@/utils/process';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import packageJson from '../../package.json';

interface WorkerState {
    pid: number;
    httpPort: number;
    version: string;
    startedAt: number;
}

function workerStateFile(): string {
    return join(configuration.happyHomeDir, 'worker.state.json');
}

function readWorkerState(): WorkerState | null {
    const filePath = workerStateFile();
    try {
        if (!existsSync(filePath)) return null;
        return JSON.parse(readFileSync(filePath, 'utf-8')) as WorkerState;
    } catch {
        return null;
    }
}

async function workerFetch<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    const state = readWorkerState();
    if (!state) return { ok: false, error: 'No worker state file' };
    if (!isProcessAlive(state.pid)) return { ok: false, error: 'Worker process not alive' };

    try {
        const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
            const text = await response.text();
            return { ok: false, error: `HTTP ${response.status}: ${text}` };
        }
        return { ok: true, data: await response.json() as T };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Check if a compatible worker is running.
 */
export function isWorkerAlive(): boolean {
    const state = readWorkerState();
    if (!state) return false;
    if (!isProcessAlive(state.pid)) return false;
    if (state.version !== packageJson.version) return false;
    return true;
}

/**
 * Get the worker's health status.
 */
export async function workerHealth(): Promise<{ version: string; sessions: number; pid: number } | null> {
    const result = await workerFetch<{ version: string; sessions: number; pid: number }>('GET', '/health');
    return result.ok ? result.data : null;
}

/**
 * Create a session on the worker. Returns sessionId on success.
 */
export async function workerCreateSession(opts: {
    directory: string;
    sessionId?: string;
    approvedNewDirectoryCreation?: boolean;
    agent?: string;
    model?: string;
    effort?: string;
    modelReasoningEffort?: string;
    yolo?: boolean;
}): Promise<{ sessionId: string } | { error: string }> {
    const result = await workerFetch<{ sessionId?: string; error?: string }>('POST', '/sessions/create', opts);
    if (!result.ok) return { error: result.error };
    if (result.data.error) return { error: result.data.error };
    return { sessionId: result.data.sessionId! };
}

/**
 * Stop a session on the worker.
 */
export async function workerStopSession(sessionId: string): Promise<boolean> {
    const result = await workerFetch<{ ok: boolean }>('POST', '/sessions/stop', { sessionId });
    return result.ok && result.data.ok;
}

/**
 * List active sessions on the worker.
 */
export async function workerListSessions(): Promise<Array<{ sessionId: string; running: boolean }>> {
    const result = await workerFetch<Array<{ sessionId: string; running: boolean }>>('GET', '/sessions/list');
    return result.ok ? result.data : [];
}

/**
 * Request the worker to shut down gracefully.
 */
export async function workerShutdown(): Promise<void> {
    await workerFetch('POST', '/shutdown');
}

/**
 * Spawn a new worker process (detached).
 * Returns once the worker state file appears with a valid port.
 */
export async function spawnWorker(): Promise<boolean> {
    logger.debug('[WORKER CLIENT] Spawning worker process');

    const child = spawnHappyCLI(['runner', 'worker-start'], {
        detached: true,
        stdio: 'ignore',
    });

    child.unref();

    // Wait for worker to write its state file (up to 10s)
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
        if (isWorkerAlive()) {
            logger.debug('[WORKER CLIENT] Worker is alive');
            return true;
        }
    }

    logger.debug('[WORKER CLIENT] Worker failed to start within timeout');
    return false;
}

/**
 * Ensure a compatible worker is running. Spawns one if needed.
 */
export async function ensureWorker(): Promise<boolean> {
    if (isWorkerAlive()) return true;
    return await spawnWorker();
}
