import { geminiLocal } from './geminiLocal';
import { GeminiSession } from './session';
import { createGeminiSessionScanner, GeminiTranscriptMessage } from './utils/sessionScanner';
import type { PermissionMode } from './types';
import { randomUUID } from 'node:crypto';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

function isToolCall(message: GeminiTranscriptMessage): message is GeminiTranscriptMessage & { id: string; type: 'tool-call'; tool_name: string; tool_input: unknown } {
    return message.type === 'tool-call' && typeof message.id === 'string' && typeof message.tool_name === 'string' && 'tool_input' in message;
}

function isToolResult(message: GeminiTranscriptMessage): message is GeminiTranscriptMessage & { id: string; type: 'tool-result'; tool_use_id: string; content: unknown; is_error: boolean } {
    return message.type === 'tool-result' && typeof message.id === 'string' && typeof message.tool_use_id === 'string' && 'content' in message && typeof message.is_error === 'boolean';
}

type GeminiScannerHandle = Awaited<ReturnType<typeof createGeminiSessionScanner>>;

function mapApprovalMode(mode: PermissionMode | undefined): string | undefined {
    if (!mode || mode === 'default' || mode === 'read-only') {
        return 'default';
    }
    if (mode === 'safe-yolo') {
        return 'auto_edit';
    }
    return 'yolo';
}

export async function geminiLocalLauncher(
    session: GeminiSession,
    opts: {
        model?: string;
        allowedTools?: string[];
        hookSettingsPath?: string;
    }
): Promise<'switch' | 'exit'> {
    const launcher = new BaseLocalLauncher({
        label: 'gemini-local',
        failureLabel: 'Local Gemini process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            await geminiLocal({
                path: session.path,
                sessionId: session.sessionId,
                abort: abortSignal,
                model: opts.model,
                approvalMode: mapApprovalMode(session.getPermissionMode() as PermissionMode | undefined),
                allowedTools: opts.allowedTools,
                hookSettingsPath: opts.hookSettingsPath
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    let scanner: GeminiScannerHandle | null = null;

    const handleTranscriptMessage = (message: GeminiTranscriptMessage) => {
        if (message.type === 'user' && typeof message.content === 'string') {
            session.sendUserMessage(message.content);
            return;
        }

        if (isToolCall(message)) {
            session.sendAgentMessage({
                type: 'tool-call',
                id: message.id,
                name: message.tool_name,
                input: message.tool_input,
                description: null,
                uuid: randomUUID(),
                parentUUID: null,
            });
            return;
        }

        if (isToolResult(message)) {
            session.sendAgentMessage({
                type: 'tool-result',
                tool_use_id: message.tool_use_id,
                content: message.content,
                is_error: message.is_error,
                uuid: randomUUID(),
                parentUUID: null,
            });
            return;
        }

        if (message.type === 'gemini' && typeof message.content === 'string') {
            session.sendAgentMessage({
                type: 'message',
                message: message.content,
                id: randomUUID()
            });
        }
    };

    const ensureScanner = async (transcriptPath: string): Promise<void> => {
        if (scanner) {
            scanner.onNewSession(transcriptPath);
            return;
        }
        scanner = await createGeminiSessionScanner({
            transcriptPath,
            onMessage: handleTranscriptMessage,
            onSessionId: (sessionId) => session.onSessionFound(sessionId)
        });
    };

    const handleTranscriptPath = (transcriptPath: string) => {
        void ensureScanner(transcriptPath);
    };

    const hadTranscriptPath = Boolean(session.transcriptPath);
    if (hadTranscriptPath && session.transcriptPath) {
        await ensureScanner(session.transcriptPath);
    } else {
        session.addTranscriptPathCallback(handleTranscriptPath);
    }

    try {
        return await launcher.run();
    } finally {
        if (!hadTranscriptPath) {
            session.removeTranscriptPathCallback(handleTranscriptPath);
        }

        if (scanner !== null) {
            await (scanner as GeminiScannerHandle).cleanup();
        }
    }
}
