import type { AgentState, Session, SessionPermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { AgentRegistry } from '@/agent/AgentRegistry';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PermissionAdapter } from '@/agent/permissionAdapter';
import type { AgentBackend, PromptContent } from '@/agent/types';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { bootstrapSession } from '@/agent/sessionFactory';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';

function emitReadyIfIdle(props: {
    queueSize: () => number;
    shouldExit: boolean;
    thinking: boolean;
    sendReady: () => void;
}): void {
    if (props.shouldExit) return;
    if (props.thinking) return;
    if (props.queueSize() > 0) return;
    props.sendReady();
}

/**
 * Dependencies that can be pre-created and injected (e.g. from the runner process).
 * When provided, the session loop reuses these instead of creating its own.
 */
export type AgentSessionDeps = {
    session: ApiSessionClient;
    sessionInfo: Session;
    agentType: string;
    workingDirectory: string;
    permissionMode?: SessionPermissionMode;
    /** External abort signal – when aborted the session loop exits gracefully. */
    abortSignal?: AbortSignal;
}

/**
 * Core agent session loop that can run with pre-created dependencies.
 * This is the shared implementation used by both the standalone CLI entry
 * point (`runAgentSession`) and the runner's session worker.
 */
export async function runAgentSessionWithDeps(deps: AgentSessionDeps): Promise<void> {
    const { session, sessionInfo, agentType, workingDirectory } = deps;

    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: false
    }));

    const messageQueue = new MessageQueue2<Record<string, never>>(() => hashObject({}));

    session.onUserMessage((message) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, {});
    });

    let currentPermissionMode: SessionPermissionMode = deps.permissionMode ?? sessionInfo.permissionMode ?? 'default';

    const backend: AgentBackend = AgentRegistry.create(agentType);
    await backend.initialize();

    const permissionAdapter = new PermissionAdapter(session, backend, () => currentPermissionMode);

    const happyServer = await startHappyServer(session);
    const bridgeCommand = getHappyCliCommand(['mcp', '--url', happyServer.url]);
    const mcpServers = [
        {
            name: 'happy',
            command: bridgeCommand.command,
            args: bridgeCommand.args,
            env: []
        }
    ];

    const agentSessionId = await backend.newSession({
        cwd: workingDirectory,
        mcpServers
    });

    let thinking = false;
    let shouldExit = false;
    let waitAbortController: AbortController | null = null;

    // Listen for external abort signal (e.g. from session worker stop)
    const onAbort = () => {
        shouldExit = true;
        if (waitAbortController) {
            waitAbortController.abort();
        }
    };
    if (deps.abortSignal) {
        deps.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const syncKeepAlive = () => {
        session.keepAlive(thinking, 'remote', {
            permissionMode: currentPermissionMode
        });
    };

    const resolvePermissionMode = (value: unknown): SessionPermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, agentType)) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as SessionPermissionMode;
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        syncKeepAlive();
        return { applied: { permissionMode: currentPermissionMode } };
    });

    syncKeepAlive();
    const keepAliveInterval = setInterval(() => {
        syncKeepAlive();
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    const handleAbort = async () => {
        logger.debug('[ACP] Abort requested');
        await backend.cancelPrompt(agentSessionId);
        await permissionAdapter.cancelAll('User aborted');
        thinking = false;
        syncKeepAlive();
        sendReady();
        if (waitAbortController) {
            waitAbortController.abort();
        }
    };

    session.rpcHandlerManager.registerHandler('abort', async () => {
        await handleAbort();
    });

    const handleKillSession = async () => {
        if (shouldExit) return;
        shouldExit = true;
        await permissionAdapter.cancelAll('Session killed');
        if (waitAbortController) {
            waitAbortController.abort();
        }
    };

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    try {
        while (!shouldExit) {
            waitAbortController = new AbortController();
            const batch = await messageQueue.waitForMessagesAndGetAsString(waitAbortController.signal);
            waitAbortController = null;
            if (!batch) {
                if (shouldExit) {
                    break;
                }
                continue;
            }

            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            thinking = true;
            syncKeepAlive();

            try {
                await backend.prompt(agentSessionId, promptContent, (message) => {
                    const converted = convertAgentMessage(message);
                    if (converted) {
                        session.sendAgentMessage(converted);
                    }
                });
            } catch (error) {
                logger.warn('[ACP] Prompt failed', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Agent prompt failed. Check logs for details.'
                });
            } finally {
                thinking = false;
                syncKeepAlive();
                await permissionAdapter.cancelAll('Prompt finished');
                emitReadyIfIdle({
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    thinking,
                    sendReady
                });
            }
        }
    } finally {
        // Clean up abort signal listener to prevent leaks
        if (deps.abortSignal) {
            deps.abortSignal.removeEventListener('abort', onAbort);
        }
        clearInterval(keepAliveInterval);
        await permissionAdapter.cancelAll('Session ended');
        session.sendSessionDeath();
        await session.flush();
        session.close();
        await backend.disconnect();
        happyServer.stop();
    }
}

/**
 * Standalone entry point – bootstraps a fresh session then runs the loop.
 * Used when `hapi claude` is invoked as a separate CLI process.
 */
export async function runAgentSession(opts: {
    agentType: string;
    startedBy?: 'runner' | 'terminal';
    permissionMode?: SessionPermissionMode;
}): Promise<void> {
    const workingDirectory = getInvokedCwd();
    const initialState: AgentState = {
        controlledByUser: false
    };
    const { session, sessionInfo } = await bootstrapSession({
        flavor: opts.agentType,
        startedBy: opts.startedBy ?? 'terminal',
        workingDirectory,
        agentState: initialState
    });

    await runAgentSessionWithDeps({
        session,
        sessionInfo,
        agentType: opts.agentType,
        workingDirectory,
        permissionMode: opts.permissionMode,
    });
}
