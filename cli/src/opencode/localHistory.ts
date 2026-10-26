import type { Metadata } from '@/api/types';

type LocalPublicationClient = {
    updateMetadata(handler: (metadata: Metadata) => Metadata): void;
    materialize(): Promise<boolean>;
    flushMetadata(): Promise<boolean>;
    flush(): Promise<boolean>;
};

// Local hooks/scanners append Hub rows even when native undo later removes
// them. Keep identities of published local messages until remote validation.
export function observeLocalHistory(
    metadata: Metadata,
    nativeSessionId: string | null,
    nativeMessageId: string | null
): Metadata {
    if (metadata.conversationHistoryDiverged) return metadata;
    const checkpoint = metadata.opencodeHistoryCheckpoint;
    if (!nativeSessionId || !nativeMessageId || (checkpoint && (checkpoint.sessionId !== nativeSessionId || checkpoint.localMessageIds === undefined))) {
        const capabilities = { ...metadata.capabilities };
        delete capabilities.conversationHistory;
        return { ...metadata, capabilities, conversationHistoryDiverged: true,
            conversationHistoryPoints: undefined, conversationHistoryIndexes: undefined, opencodeHistoryCheckpoint: undefined };
    }
    return { ...metadata, opencodeHistoryCheckpoint: {
        ...(checkpoint ?? { sessionId: nativeSessionId, messageIds: [], userMessageIds: [] }),
        localMessageIds: [...new Set([...(checkpoint?.localMessageIds ?? []), nativeMessageId])]
    } };
}

// Journal each local publication before sending content, and leave the guard
// set until the Hub has acknowledged both the content and the final metadata.
export function createLocalHistoryPublisher(client: LocalPublicationClient, onError: (error: unknown) => void) {
    let tail = Promise.resolve();
    let failed = false;
    return {
        publish(nativeSessionId: string | null, nativeMessageId: string | null, send: () => void): void {
            tail = tail.then(async () => {
                if (failed) return;
                client.updateMetadata((metadata) => {
                    const observed = observeLocalHistory(metadata, nativeSessionId, nativeMessageId);
                    return observed.opencodeHistoryCheckpoint ? { ...observed, opencodeHistoryCheckpoint: {
                        ...observed.opencodeHistoryCheckpoint, localPublicationPending: true
                    } } : observed;
                });
                if (!await client.materialize() || !await client.flushMetadata()) {
                    throw new Error('Local history observation could not be persisted');
                }
                send();
                if (!await client.flush()) throw new Error('Local history content was not acknowledged');
                client.updateMetadata((metadata) => metadata.opencodeHistoryCheckpoint ? { ...metadata,
                    opencodeHistoryCheckpoint: { ...metadata.opencodeHistoryCheckpoint, localPublicationPending: undefined }
                } : metadata);
                if (!await client.flushMetadata()) throw new Error('Local history publication could not be committed');
            }).catch((error) => {
                failed = true;
                try { client.updateMetadata((metadata) => observeLocalHistory(metadata, nativeSessionId, null)); } catch {}
                onError(error);
            });
        },
        async flush(): Promise<void> { await tail; }
    };
}
