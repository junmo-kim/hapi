/**
 * InProcessSession – runs an agent session inside the current process
 * instead of spawning a separate `hapi claude` wrapper process.
 *
 * Used by the Session Worker to host multiple sessions in a single
 * Node.js process, sharing V8 heap and loaded modules.
 */

import { ApiClient } from '@/api/api';
import type { AgentState, Session } from '@/api/types';
import { bootstrapSession } from '@/agent/sessionFactory';
import { runAgentSessionWithDeps } from '@/agent/runners/runAgentSession';
import { logger } from '@/ui/logger';
import type { SpawnSessionOptions } from '@/modules/common/rpcTypes';

export interface InProcessSessionOptions {
    api: ApiClient;
    machineId: string;
    spawnOptions: SpawnSessionOptions;
}

export class InProcessSession {
    private abortController = new AbortController();
    private _sessionId?: string;
    private _running = false;
    private _runPromise?: Promise<void>;

    constructor(private readonly opts: InProcessSessionOptions) {}

    get sessionId(): string | undefined {
        return this._sessionId;
    }

    get running(): boolean {
        return this._running;
    }

    /**
     * Bootstrap and start the session loop. Returns the hub session ID.
     * The agent loop runs in the background – await `waitUntilDone()` to
     * block until it finishes.
     */
    async start(): Promise<string> {
        const { api, machineId, spawnOptions } = this.opts;
        const workingDirectory = spawnOptions.directory;
        const agentType = spawnOptions.agent ?? 'claude';

        const initialState: AgentState = {
            controlledByUser: false
        };

        const { session, sessionInfo } = await bootstrapSession({
            flavor: agentType,
            startedBy: 'runner',
            workingDirectory,
            agentState: initialState,
            model: spawnOptions.model,
            effort: spawnOptions.effort,
            modelReasoningEffort: spawnOptions.modelReasoningEffort,
            existingApi: api,
            existingMachineId: machineId,
        });

        this._sessionId = sessionInfo.id;
        this._running = true;

        this._runPromise = this.runWithErrorBoundary(
            session,
            sessionInfo,
            agentType,
            workingDirectory,
            spawnOptions,
        );

        return sessionInfo.id;
    }

    private async runWithErrorBoundary(
        session: import('@/api/apiSession').ApiSessionClient,
        sessionInfo: Session,
        agentType: string,
        workingDirectory: string,
        spawnOptions: SpawnSessionOptions,
    ): Promise<void> {
        try {
            await runAgentSessionWithDeps({
                session,
                sessionInfo,
                agentType,
                workingDirectory,
                permissionMode: spawnOptions.yolo ? 'yolo' : undefined,
                abortSignal: this.abortController.signal,
            });
        } catch (error) {
            // Contain the error – never let it propagate to the worker's
            // global uncaughtException handler.
            logger.debug(
                `[InProcessSession] Session ${this._sessionId} crashed:`,
                error instanceof Error ? error.message : String(error)
            );
            if (error instanceof Error && error.stack) {
                logger.debug(`[InProcessSession] Stack: ${error.stack}`);
            }
        } finally {
            this._running = false;
        }
    }

    async waitUntilDone(): Promise<void> {
        await this._runPromise;
    }

    async stop(): Promise<void> {
        if (!this._running || !this._runPromise) return;
        this.abortController.abort();
        await this._runPromise;
    }
}
