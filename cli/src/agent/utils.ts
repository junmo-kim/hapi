import { isObject } from '@hapi/protocol';

type ToolNameSource = 'title' | 'raw_input_name' | 'raw_input_tool' | 'kind' | 'default';

export type CanonicalDiffToolInput =
    | { name: 'Edit'; input: { file_path: string; old_string: string; new_string: string; replace_all?: boolean } }
    | { name: 'Write'; input: { file_path: string; content: string } };

function firstString(value: unknown, keys: readonly string[]): string | null {
    if (!isObject(value)) return null;
    for (const key of keys) {
        const candidate = value[key];
        if (typeof candidate === 'string') return candidate;
    }
    return null;
}

/**
 * Detects diff/write-shaped tool inputs emitted by ACP agents that keep their
 * native argument shapes (OpenCode: `{filePath, oldString, newString}` for
 * edit and `{filePath, content}` for write) and normalizes them to the
 * Claude-shaped inputs the web Edit/Write views render.
 *
 * Shape-based on purpose: a path plus both old/new strings is unambiguously an
 * edit, and a path plus content (without old/new) a write. No kind/name gate —
 * gating on agent-specific kind vocabulary would miss variants that omit it,
 * and rendering such a shape as a diff is correct even if one slips through.
 *
 * Returns null for everything else so callers keep their existing fallback.
 */
export function canonicalizeDiffToolInput(rawInput: unknown): CanonicalDiffToolInput | null {
    const filePath = firstString(rawInput, ['filePath', 'file_path']);
    if (filePath === null || filePath.length === 0) return null;

    const oldString = firstString(rawInput, ['oldString', 'old_string']);
    const newString = firstString(rawInput, ['newString', 'new_string']);
    if (oldString !== null && newString !== null) {
        const replaceAll = isObject(rawInput) && typeof rawInput.replaceAll === 'boolean'
            ? rawInput.replaceAll
            : undefined;
        return {
            name: 'Edit',
            input: {
                file_path: filePath,
                old_string: oldString,
                new_string: newString,
                ...(replaceAll === undefined ? {} : { replace_all: replaceAll }),
            },
        };
    }

    const content = firstString(rawInput, ['content']);
    if (content !== null) {
        return { name: 'Write', input: { file_path: filePath, content } };
    }

    return null;
}

function normalizeToolName(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function isPlaceholderToolName(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized === '' || normalized === 'tool' || normalized === 'unknown' || normalized === 'other';
}

export function deriveToolNameWithSource(input: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
    metaKind?: string | null;
}): { name: string; source: ToolNameSource } {
    const title = normalizeToolName(input.title);
    if (title) {
        return { name: title, source: 'title' };
    }

    if (isObject(input.rawInput)) {
        const fromName = normalizeToolName(input.rawInput.name);
        if (fromName) {
            return { name: fromName, source: 'raw_input_name' };
        }

        const fromTool = normalizeToolName(input.rawInput.tool);
        if (fromTool) {
            return { name: fromTool, source: 'raw_input_tool' };
        }
    }

    // ACP agents (Gemini, Kimi) use kind=edit/write/replace with _meta.kind to
    // distinguish write_file (add) from replace (modify). Normalise the kind
    // so aliases like 'write', 'replace', 'modify' are handled the same way.
    const normalizedKind = typeof input.kind === 'string'
        ? input.kind.toLowerCase().trim()
        : null;
    if (normalizedKind === 'edit' || normalizedKind === 'write' || normalizedKind === 'write_file' || normalizedKind === 'replace' || normalizedKind === 'modify' || normalizedKind === 'file_edit') {
        if (input.metaKind === 'add') {
            return { name: 'Write', source: 'kind' };
        }
        if (input.metaKind === 'modify') {
            return { name: 'Edit', source: 'kind' };
        }
    }

    const kind = normalizeToolName(input.kind);
    if (kind && !isPlaceholderToolName(kind)) {
        return { name: kind, source: 'kind' };
    }

    return { name: 'Tool', source: 'default' };
}

export function deriveToolName(input: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
    metaKind?: string | null;
}): string {
    return deriveToolNameWithSource(input).name;
}
