/**
 * Session Worker – a long-lived detached process that hosts multiple
 * agent sessions in-process, sharing a single V8 heap and loaded modules.
 *
 * Lifecycle:
 *   - Spawned by Runner on first session request (lazy start)
 *   - Exits when active session count drops to zero (auto-cleanup)
 *   - Survives Runner restarts (detached process)
 *
 * IPC: localhost HTTP (Fastify), same pattern as controlServer.ts
 */

import fastify from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ApiClient } from '@/api/api';
import { readSettings } from '@/persistence';
import { buildMachineMetadata } from '@/agent/sessionFactory';
import { logger } from '@/ui/logger';
import { InProcessSession } from './InProcessSession';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';

const IDLE_TIMEOUT_MS = 30_000; // Auto-exit after 30s with no sessions

interface WorkerState {
    pid: number;
    httpPort: number;
    version: string;
    startedAt: number;
}

function workerStateFile(): string {
    return join(configuration.happyHomeDir, 'worker.state.json');
}

function writeWorkerState(state: WorkerState): void {
    const filePath = workerStateFile();
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

function clearWorkerState(): void {
    const filePath = workerStateFile();
    try {
        if (existsSync(filePath)) {
            unlinkSync(filePath);
        }
    } catch {
        // Best effort
    }
}

export async function startSessionWorker(): Promise<void> {
    const sessions = new Map<string, InProcessSession>();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    // Bootstrap shared dependencies
    const api = await ApiClient.create();
    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        logger.debug('[WORKER] No machineId found in settings');
        process.exit(1);
    }
    await api.getOrCreateMachine({ machineId, metadata: buildMachineMetadata() });

    async function shutdown() {
        logger.debug(`[WORKER] Shutting down, stopping ${sessions.size} session(s)`);
        await Promise.allSettled(
            Array.from(sessions.values()).map(s => s.stop())
        );
        clearWorkerState();
        process.exit(0);
    }

    function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        if (sessions.size === 0) {
            idleTimer = setTimeout(() => {
                if (sessions.size === 0) {
                    logger.debug('[WORKER] No active sessions, shutting down');
                    shutdown();
                }
            }, IDLE_TIMEOUT_MS);
        }
    }

    // Fastify server (same pattern as controlServer.ts)
    const app = fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Create session
    typed.post('/sessions/create', {
        schema: {
            body: z.object({
                directory: z.string(),
                sessionId: z.string().optional(),
                approvedNewDirectoryCreation: z.boolean().optional(),
                agent: z.enum(['claude', 'codex', 'cursor', 'gemini', 'opencode']).optional(),
                model: z.string().optional(),
                effort: z.string().optional(),
                modelReasoningEffort: z.string().optional(),
                yolo: z.boolean().optional(),
            }),
            response: {
                200: z.object({ sessionId: z.string() }),
                500: z.object({ error: z.string() }),
            }
        }
    }, async (request, reply) => {
        const opts = request.body;
        try {
            const inProcess = new InProcessSession({
                api,
                machineId,
                spawnOptions: { ...opts, directory: opts.directory },
            });
            const sessionId = await inProcess.start();
            sessions.set(sessionId, inProcess);

            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }

            // Auto-cleanup when session finishes
            inProcess.waitUntilDone().then(() => {
                sessions.delete(sessionId);
                logger.debug(`[WORKER] Session ${sessionId} finished, ${sessions.size} remaining`);
                resetIdleTimer();
            });

            return { sessionId };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.debug('[WORKER] Failed to create session:', msg);
            reply.code(500);
            return { error: msg };
        }
    });

    // Stop session
    typed.post('/sessions/stop', {
        schema: {
            body: z.object({ sessionId: z.string() }),
            response: {
                200: z.object({ ok: z.boolean() }),
            }
        }
    }, async (request) => {
        const session = sessions.get(request.body.sessionId);
        if (!session) return { ok: false };
        await session.stop();
        return { ok: true };
    });

    // List sessions
    typed.get('/sessions/list', {
        schema: {
            response: {
                200: z.array(z.object({
                    sessionId: z.string(),
                    running: z.boolean(),
                })),
            }
        }
    }, async () => {
        return Array.from(sessions.entries()).map(([id, s]) => ({
            sessionId: id,
            running: s.running,
        }));
    });

    // Health / version check
    typed.get('/health', {
        schema: {
            response: {
                200: z.object({
                    version: z.string(),
                    sessions: z.number(),
                    pid: z.number(),
                }),
            }
        }
    }, async () => ({
        version: packageJson.version,
        sessions: sessions.size,
        pid: process.pid,
    }));

    // Graceful shutdown
    typed.post('/shutdown', {
        schema: {
            response: {
                200: z.object({ ok: z.boolean() }),
            }
        }
    }, async () => {
        setTimeout(() => shutdown(), 50);
        return { ok: true };
    });

    // Start listening
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const port = parseInt(address.split(':').pop()!);

    writeWorkerState({
        pid: process.pid,
        httpPort: port,
        version: packageJson.version,
        startedAt: Date.now(),
    });

    logger.debug(`[WORKER] Started on port ${port}, PID ${process.pid}`);

    // Start idle timer
    resetIdleTimer();

    // Handle signals
    process.on('SIGTERM', () => shutdown());
    process.on('SIGINT', () => shutdown());
}
