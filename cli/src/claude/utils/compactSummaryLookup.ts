import { readFile } from 'node:fs/promises';
import { RawJSONLinesSchema } from '../types';

/**
 * Looks up the compact summary body Claude Code writes to the local session
 * transcript (`<projectDir>/<sessionId>.jsonl`). The SDK stream carries only
 * the boundary metadata, so the transcript is the sole source for the summary
 * text. Claude Code may flush it slightly after the result arrives, hence the
 * bounded polling.
 */

export function extractCompactSummaryFromTranscript(content: string): string | null {
    let latest: string | null = null;
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(trimmed);
        } catch {
            continue;
        }
        const parsed = RawJSONLinesSchema.safeParse(parsedJson);
        if (!parsed.success || parsed.data.type !== 'user' || !parsed.data.isCompactSummary) {
            continue;
        }
        const text = extractText((parsed.data.message as { content?: unknown } | undefined)?.content);
        if (text !== null) latest = text;
    }
    return latest;
}

function extractText(content: unknown): string | null {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(content)) {
        const joined = content
            .filter((block): block is { type: 'text'; text: string } =>
                typeof block === 'object' && block !== null &&
                (block as any).type === 'text' && typeof (block as any).text === 'string')
            .map((block) => block.text.trim())
            .join('\n')
            .trim();
        return joined.length > 0 ? joined : null;
    }
    return null;
}

export async function findLatestCompactSummary(
    transcriptPath: string,
    opts?: {
        attempts?: number;
        intervalMs?: number;
        sleep?: (ms: number) => Promise<void>;
    }
): Promise<string | null> {
    const attempts = opts?.attempts ?? 10;
    const intervalMs = opts?.intervalMs ?? 500;
    const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const content = await readFile(transcriptPath, 'utf8');
            const summary = extractCompactSummaryFromTranscript(content);
            if (summary !== null) return summary;
        } catch {
            // Missing or unreadable transcript: keep polling until attempts run out.
        }
        if (attempt < attempts - 1) await sleep(intervalMs);
    }
    return null;
}
