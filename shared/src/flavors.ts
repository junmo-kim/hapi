import type { PermissionMode, SteeringCapability, SteeringSessionMetadata, SteeringSessionState } from './modes'
import type { Metadata } from './schemas'

/** Metadata keys that can hold a flavor's native resume id. */
export type NativeSessionIdField =
    | 'agySessionId'
    | 'claudeSessionId'
    | 'codexSessionId'
    | 'copilotSessionId'
    | 'cursorSessionId'
    | 'dshSessionId'
    | 'geminiSessionId'
    | 'grokSessionId'
    | 'kimiSessionId'
    | 'opencodeSessionId'
    | 'piSessionId'

/** Stored message format that can recover a missing native id. */
export const NativeIdRecovery = {
    Codex: 'codex',
    Claude: 'claude',
} as const

export type NativeIdRecoverySource = typeof NativeIdRecovery[keyof typeof NativeIdRecovery]

export const Capabilities = {
    ModelChange: 'model-change',
    Effort: 'effort',
} as const

export type Capability = typeof Capabilities[keyof typeof Capabilities]

/** `decision`: approve / approve-for-session / abort. `allowTools`: allow / allow-tools-for-session / allow-all-edits. `generic`: allow / allow-for-session / deny. */
export type PermissionReplyStyle = 'decision' | 'allowTools' | 'generic'

type FlavorTraits = {
    readonly label: string
    readonly capabilities: ReadonlySet<Capability>
    readonly permissionReplyStyle: PermissionReplyStyle
    /** Permission modes offered for the flavor; empty when the flavor has none. */
    readonly permissionModes: readonly PermissionMode[]
    /** Whether the mode is one of the flavor's permission modes. */
    allowsPermissionMode(mode: string): mode is PermissionMode
    /** New-session form permission mode: `shared` selectable in the shared form state, `separate` selectable in the flavor's own state, `managed` not selectable. */
    readonly permissionCreateFormModeSource: 'shared' | 'separate' | 'managed'
    /** Mode a saved YOLO toggle migrates to in the new-session form; null if it is not migrated. */
    readonly yoloToggleMigrationMode: PermissionMode | null
    /** Mode that auto-approves everything; null if the flavor has none. */
    readonly yoloPermissionMode: PermissionMode | null
    /** Tools whose name starts with this are answered with decisions in any session; null if none. */
    readonly decisionToolNamePrefix: string | null
    /** Offered when creating a new session. */
    readonly creatable: boolean
    /** How a queued message is delivered into an active turn; null if the flavor cannot steer. */
    readonly steering: SteeringCapability | null
    /** Metadata key holding this flavor's native resume id; null when it has none. */
    readonly nativeSessionIdField: NativeSessionIdField | null
    /** True when the same native id on another machine is a different conversation. */
    readonly machineScopedNativeId: boolean
    /** True when a missing native id can be recovered from stored messages. */
    readonly recoversNativeIdFromMessages: boolean
    /** Stored messages that recover this flavor's native id; null when none. */
    readonly nativeIdRecoveryFromMessages: NativeIdRecoverySource | null
    /** Position in the read order when a row carries several native ids. */
    readonly nativeIdReadOrder: number
    /** Position in the legacy unknown-flavor read order; null when excluded. */
    readonly legacyNativeIdReadOrder: number | null
}

type FlavorSpec<
    TModes extends readonly PermissionMode[],
    TNativeSessionIdField extends NativeSessionIdField | null
> = {
    label: string
    capabilities: ReadonlySet<Capability>
    permissionReplyStyle: PermissionReplyStyle
    permissionModes: TModes
    decisionToolNamePrefix: string | null
    /** The new-session form keeps this flavor's mode in its own state instead of the shared one. */
    ownPermissionFormState: boolean
    /** Saved new-session YOLO toggles from before permission modes migrate to the auto-approve mode. */
    migratesYoloToggle: boolean
    creatable: boolean
    steering: SteeringCapability | null
    nativeSessionIdField: TNativeSessionIdField
    machineScopedNativeId: boolean
    recoversNativeIdFromMessages: boolean
    nativeIdRecoveryFromMessages: NativeIdRecoverySource | null
    nativeIdReadOrder: number
    legacyNativeIdReadOrder: number | null
}

const AUTO_APPROVE_MODES: readonly PermissionMode[] = ['yolo', 'bypassPermissions', 'always-proceed']

/** Traits inferred from a flavor declaration, preserving its literal fields. */
export type FlavorOf<
    TModes extends readonly PermissionMode[],
    TNativeSessionIdField extends NativeSessionIdField | null
> = Omit<FlavorTraits, 'permissionModes' | 'allowsPermissionMode' | 'nativeSessionIdField'> & {
    readonly permissionModes: TModes
    readonly nativeSessionIdField: TNativeSessionIdField
    allowsPermissionMode(mode: string): mode is TModes[number]
}

function defineFlavor<
    const TModes extends readonly PermissionMode[],
    const TNativeSessionIdField extends NativeSessionIdField | null
>(
    spec: FlavorSpec<TModes, TNativeSessionIdField>
): FlavorOf<TModes, TNativeSessionIdField> {
    const autoApproveModes = spec.permissionModes.filter((mode) => AUTO_APPROVE_MODES.includes(mode))
    if (autoApproveModes.length > 1) {
        throw new Error(`Flavor ${spec.label} lists more than one auto-approve mode: ${autoApproveModes.join(', ')}`)
    }
    const yoloPermissionMode = autoApproveModes[0] ?? null
    return {
        label: spec.label,
        capabilities: spec.capabilities,
        permissionReplyStyle: spec.permissionReplyStyle,
        permissionModes: spec.permissionModes,
        allowsPermissionMode: (mode): mode is TModes[number] => (spec.permissionModes as readonly string[]).includes(mode),
        permissionCreateFormModeSource: spec.permissionModes.length === 0
            ? 'managed'
            : spec.ownPermissionFormState ? 'separate' : 'shared',
        yoloToggleMigrationMode: spec.migratesYoloToggle ? yoloPermissionMode : null,
        yoloPermissionMode,
        decisionToolNamePrefix: spec.decisionToolNamePrefix,
        creatable: spec.creatable,
        steering: spec.steering,
        nativeSessionIdField: spec.nativeSessionIdField,
        machineScopedNativeId: spec.machineScopedNativeId,
        recoversNativeIdFromMessages: spec.recoversNativeIdFromMessages,
        nativeIdRecoveryFromMessages: spec.nativeIdRecoveryFromMessages,
        nativeIdReadOrder: spec.nativeIdReadOrder,
        legacyNativeIdReadOrder: spec.legacyNativeIdReadOrder,
    }
}

// Only sessions running on agy acp can steer.
function isAgyAcpSession(metadata: SteeringSessionMetadata): boolean {
    return metadata.agyProtocol === 'acp'
}

// Legacy stream-json sessions cannot steer, including pre-ACP sessions with only an id.
function isCursorAcpSession(metadata: SteeringSessionMetadata): boolean {
    return metadata.cursorSessionProtocol !== 'stream-json'
        && (Boolean(metadata.cursorSessionProtocol) || !metadata.cursorSessionId)
}

const agy = defineFlavor({
    label: 'Antigravity',
    nativeSessionIdField: 'agySessionId',
    machineScopedNativeId: true,
    recoversNativeIdFromMessages: false,
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: 8,
    legacyNativeIdReadOrder: 6,
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'generic',
    permissionModes: ['request-review', 'acceptEdits', 'plan', 'always-proceed'],
    decisionToolNamePrefix: null,
    ownPermissionFormState: false,
    migratesYoloToggle: true,
    creatable: true,
    // Concurrent ACP `session/prompt` (`agy acp`); agy answers the interrupted request at once and folds the steer in after any running tool call finishes.
    steering: { activeTurnState: 'steeringActive', supportsSession: isAgyAcpSession },
})

const claude = defineFlavor({
    label: 'Claude',
    nativeSessionIdField: 'claudeSessionId',
    machineScopedNativeId: true,
    recoversNativeIdFromMessages: true,
    nativeIdRecoveryFromMessages: NativeIdRecovery.Claude,
    nativeIdReadOrder: 2,
    legacyNativeIdReadOrder: 2,
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'allowTools',
    permissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
    decisionToolNamePrefix: null,
    ownPermissionFormState: false,
    migratesYoloToggle: true,
    creatable: true,
    // Stream-json stdin write during the turn (TUI Ctrl+X Ctrl+S); folded in at the next tool boundary, remote mode only.
    steering: { activeTurnState: 'steeringActive' },
})

const codex = defineFlavor({
    label: 'Codex',
    nativeSessionIdField: 'codexSessionId',
    machineScopedNativeId: true,
    recoversNativeIdFromMessages: true,
    nativeIdRecoveryFromMessages: NativeIdRecovery.Codex,
    nativeIdReadOrder: 1,
    legacyNativeIdReadOrder: 1,
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'read-only', 'autoReview', 'yolo'],
    decisionToolNamePrefix: 'Codex',
    ownPermissionFormState: false,
    migratesYoloToggle: true,
    creatable: true,
    // App-server `turn/steer` (true mid-turn inject).
    steering: { activeTurnState: 'steeringActive' },
})

const dsh = defineFlavor({
    label: 'DeepSeek Harness',
    nativeSessionIdField: 'dshSessionId',
    machineScopedNativeId: true,
    recoversNativeIdFromMessages: false,
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: 11,
    legacyNativeIdReadOrder: 10,
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'generic',
    // DSH applies its own server-side permission policy, so no modes are offered.
    permissionModes: [],
    decisionToolNamePrefix: null,
    ownPermissionFormState: false,
    migratesYoloToggle: false,
    creatable: true,
    steering: null,
})

const copilot = defineFlavor({
    label: 'Copilot',
    nativeSessionIdField: 'copilotSessionId',
    machineScopedNativeId: false,
    recoversNativeIdFromMessages: false,
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: 9,
    legacyNativeIdReadOrder: 9,
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
    decisionToolNamePrefix: 'Copilot',
    ownPermissionFormState: false,
    migratesYoloToggle: false,
    creatable: true,
    steering: null,
})

const cursor = defineFlavor({
    label: 'Cursor',
    nativeSessionIdField: 'cursorSessionId',
    machineScopedNativeId: true,
    recoversNativeIdFromMessages: false,
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: 6,
    legacyNativeIdReadOrder: 7,
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'plan', 'ask', 'debug', 'autoReview', 'yolo'],
    decisionToolNamePrefix: 'Cursor',
    ownPermissionFormState: false,
    migratesYoloToggle: true,
    creatable: true,
    // ACP: concurrent `session/prompt` soft-send without cancel; legacy stream-json sessions cannot steer.
    steering: { activeTurnState: 'steeringActive', supportsSession: isCursorAcpSession },
})

const gemini = defineFlavor({
    label: 'Gemini',
    nativeSessionIdField: 'geminiSessionId',
    machineScopedNativeId: false,
    recoversNativeIdFromMessages: false,
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: 3,
    legacyNativeIdReadOrder: 3,
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
    decisionToolNamePrefix: 'Gemini',
    ownPermissionFormState: false,
    migratesYoloToggle: false,
    // Google sunset the consumer Gemini CLI, so it cannot be launched; stored sessions stay viewable.
    creatable: false,
    steering: null,
})

const grok = defineFlavor({
    label: 'Grok Build',
    nativeSessionIdField: 'grokSessionId',
    machineScopedNativeId: true,
    recoversNativeIdFromMessages: false,
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: 5,
    legacyNativeIdReadOrder: 5,
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'auto', 'plan', 'bypassPermissions'],
    decisionToolNamePrefix: null,
    // Its Auto mode depends on a machine capability, so the form keeps grok's mode apart.
    ownPermissionFormState: true,
    migratesYoloToggle: false,
    creatable: true,
    steering: null,
})

const kimi = defineFlavor({
    label: 'Kimi',
    nativeSessionIdField: 'kimiSessionId',
    machineScopedNativeId: true,
    recoversNativeIdFromMessages: false,
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: 10,
    legacyNativeIdReadOrder: 8,
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
    decisionToolNamePrefix: null,
    ownPermissionFormState: false,
    migratesYoloToggle: false,
    creatable: true,
    steering: null,
})

const opencode = defineFlavor({
    label: 'OpenCode',
    nativeSessionIdField: 'opencodeSessionId',
    machineScopedNativeId: true,
    recoversNativeIdFromMessages: false,
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: 4,
    legacyNativeIdReadOrder: 4,
    capabilities: new Set([Capabilities.ModelChange]),
    permissionReplyStyle: 'decision',
    permissionModes: ['default', 'plan', 'yolo'],
    decisionToolNamePrefix: 'OpenCode',
    ownPermissionFormState: false,
    migratesYoloToggle: false,
    creatable: true,
    // v1: concurrent ACP `session/prompt`; v2: durable REST inbox steering at a native step boundary. Both require live steeringActive.
    steering: { activeTurnState: 'steeringActive' },
})

const pi = defineFlavor({
    label: 'Pi',
    nativeSessionIdField: 'piSessionId',
    machineScopedNativeId: true,
    recoversNativeIdFromMessages: false,
    // Legacy rows predate Pi; an unknown flavor must not infer a Pi identity from a stale field.
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: 7,
    legacyNativeIdReadOrder: null,
    capabilities: new Set([Capabilities.ModelChange, Capabilities.Effort]),
    permissionReplyStyle: 'generic',
    // Pi RPC always auto-approves, so no modes are offered.
    permissionModes: [],
    decisionToolNamePrefix: null,
    ownPermissionFormState: false,
    migratesYoloToggle: false,
    creatable: true,
    // Native steer over the Pi runtime.
    steering: { activeTurnState: 'thinking' },
})

// One entry per flavor; the key is the flavor id stored in session metadata.
export const Flavors = {
    agy, claude, codex, dsh, copilot, cursor, gemini, grok, kimi, opencode, pi,
} satisfies Record<string, FlavorTraits>

export type AgentFlavor = keyof typeof Flavors

/** Flavor keys whose declarations include a native id field. */
export type NativeIdFlavor = {
    [K in AgentFlavor]: typeof Flavors[K]['nativeSessionIdField'] extends NativeSessionIdField ? K : never
}[AgentFlavor]

/** Native id metadata key declared by a flavor. */
export type NativeIdFieldOf<T extends NativeIdFlavor> = typeof Flavors[T]['nativeSessionIdField']

// Object.keys is not typed per key and z.enum needs a non-empty tuple.
export const AGENT_FLAVORS = Object.keys(Flavors) as unknown as readonly [AgentFlavor, ...AgentFlavor[]]

export const CREATABLE_AGENT_FLAVORS: readonly AgentFlavor[] = AGENT_FLAVORS.filter(
    (flavor) => Flavors[flavor].creatable
)

/** Permission mode union declared by a flavor, for example `PermissionModeOf<typeof Flavors.codex>`. */
export type PermissionModeOf<T extends { readonly permissionModes: readonly PermissionMode[] }> = T['permissionModes'][number]

const UNKNOWN_FLAVOR_TRAITS: FlavorTraits = {
    label: 'Unknown',
    capabilities: new Set<Capability>(),
    permissionReplyStyle: 'generic',
    // Unknown flavors fall back to the Claude list.
    permissionModes: claude.permissionModes,
    allowsPermissionMode: claude.allowsPermissionMode,
    permissionCreateFormModeSource: 'managed',
    yoloToggleMigrationMode: null,
    yoloPermissionMode: null,
    decisionToolNamePrefix: null,
    creatable: false,
    steering: null,
    nativeSessionIdField: null,
    machineScopedNativeId: false,
    recoversNativeIdFromMessages: false,
    nativeIdRecoveryFromMessages: null,
    nativeIdReadOrder: Number.MAX_SAFE_INTEGER,
    legacyNativeIdReadOrder: null,
}

function traitsOf(flavor: string | null | undefined): FlavorTraits {
    return isKnownFlavor(flavor) ? Flavors[flavor] : UNKNOWN_FLAVOR_TRAITS
}

// --- Query functions ---
export function isKnownFlavor(flavor: string | null | undefined): flavor is AgentFlavor {
    return typeof flavor === 'string' && Object.hasOwn(Flavors, flavor)
}

export function hasCapability(flavor: string | null | undefined, cap: Capability): boolean {
    return traitsOf(flavor).capabilities.has(cap)
}

export function getFlavorLabel(flavor: string | null | undefined): string {
    return traitsOf(flavor).label
}

export function getNativeSessionIdField(flavor: string | null | undefined): NativeSessionIdField | null {
    return traitsOf(flavor).nativeSessionIdField
}

const FLAVOR_BY_NATIVE_ID_FIELD = new Map<NativeSessionIdField, AgentFlavor>(
    AGENT_FLAVORS.flatMap((flavor) => {
        const field = getNativeSessionIdField(flavor)
        return field === null ? [] : [[field, flavor] as const]
    })
)

/** Flavor that declares a native id field, for callers holding only a metadata key. */
export function getFlavorForNativeIdField(field: NativeSessionIdField | null | undefined): AgentFlavor | undefined {
    return field === null || field === undefined ? undefined : FLAVOR_BY_NATIVE_ID_FIELD.get(field)
}

export function isMachineScopedNativeId(flavor: string | null | undefined): boolean {
    return traitsOf(flavor).machineScopedNativeId
}

export function recoversNativeIdFromMessages(flavor: string | null | undefined): boolean {
    return traitsOf(flavor).recoversNativeIdFromMessages
}

export function getNativeIdRecoverySource(flavor: string | null | undefined): NativeIdRecoverySource | null {
    return traitsOf(flavor).nativeIdRecoveryFromMessages
}

/** Whether the flavor's native id is a Codex thread id, so Codex bindings apply. */
export function usesCodexThreadId(flavor: string | null | undefined): boolean {
    return getNativeSessionIdField(flavor) === 'codexSessionId'
}

/** Whether the flavor's native id is a Pi thread id. */
export function usesPiThreadId(flavor: string | null | undefined): boolean {
    return getNativeSessionIdField(flavor) === 'piSessionId'
}

/** Whether the flavor's native id is stored in the Cursor on-disk chat store. */
export function usesCursorChatStore(flavor: string | null | undefined): boolean {
    return getNativeSessionIdField(flavor) === 'cursorSessionId'
}

/** All declared native id keys in the fixed order used when a row carries several. */
export function getNativeIdFieldsInReadOrder(): readonly NativeSessionIdField[] {
    return AGENT_FLAVORS
        .slice()
        .sort((a, b) => traitsOf(a).nativeIdReadOrder - traitsOf(b).nativeIdReadOrder)
        .map((flavor) => getNativeSessionIdField(flavor))
        .filter((field): field is NativeSessionIdField => field !== null)
}

/** Legacy native id keys for rows whose flavor is missing or unknown. */
export function getLegacyNativeIdFieldsInReadOrder(): readonly NativeSessionIdField[] {
    const order = (flavor: AgentFlavor) => traitsOf(flavor).legacyNativeIdReadOrder
    return AGENT_FLAVORS
        .filter((flavor) => order(flavor) !== null)
        .sort((a, b) => (order(a) ?? 0) - (order(b) ?? 0))
        .map((flavor) => getNativeSessionIdField(flavor))
        .filter((field): field is NativeSessionIdField => field !== null)
}

export function getNativeSessionId(
    metadata: Metadata | null | undefined,
    flavor: string | null | undefined
): string | undefined {
    const field = getNativeSessionIdField(flavor)
    if (!field || !metadata) return undefined
    const value = metadata[field]
    return typeof value === 'string' ? value : undefined
}

/** Returns metadata with `id` stored in the flavor's declared native id field. */
export function withNativeSessionId<T extends NativeIdFlavor>(
    metadata: Metadata,
    flavor: T,
    id: string
): Metadata & Record<NativeIdFieldOf<T>, string> {
    const field: NativeIdFieldOf<T> = Flavors[flavor].nativeSessionIdField
    return { ...metadata, [field]: id } as Metadata & Record<NativeIdFieldOf<T>, string>
}

// --- Convenience functions ---
export function supportsModelChange(flavor: string | null | undefined): boolean {
    return hasCapability(flavor, Capabilities.ModelChange)
}

export function supportsEffort(flavor: string | null | undefined): boolean {
    return hasCapability(flavor, Capabilities.Effort)
}

const DECISION_TOOL_NAME_PREFIXES: readonly string[] = Object.values(Flavors)
    .map((traits) => traits.decisionToolNamePrefix)
    .filter((prefix): prefix is string => prefix !== null)

export function getPermissionReplyStyle(
    flavor: string | null | undefined,
    toolName?: string
): PermissionReplyStyle {
    if (toolName && DECISION_TOOL_NAME_PREFIXES.some((prefix) => toolName.startsWith(prefix))) {
        return 'decision'
    }
    return traitsOf(flavor).permissionReplyStyle
}

export function usesNativePermissionSelect(flavor: string | null | undefined): boolean {
    return traitsOf(flavor).permissionCreateFormModeSource !== 'managed'
}

export function usesSharedPermissionModeState(flavor: string | null | undefined): boolean {
    return traitsOf(flavor).permissionCreateFormModeSource === 'shared'
}

export function getYoloToggleMigrationMode(flavor: string | null | undefined): PermissionMode | null {
    return traitsOf(flavor).yoloToggleMigrationMode
}

export function resolveHapiYoloPermissionMode(flavor: string | null | undefined): PermissionMode | null {
    return traitsOf(flavor).yoloPermissionMode
}

/** Flavors that can deliver a queued message into an active turn without waiting for the turn to end; the UI hides Steer for the others. */
export const STEERING_SUPPORTED_FLAVORS: readonly AgentFlavor[] = AGENT_FLAVORS.filter(
    (flavor) => Flavors[flavor].steering !== null
)

function getSteeringCapability(flavor?: string | null): SteeringCapability | null {
    return traitsOf(flavor).steering
}

export function isSteeringSupportedForFlavor(flavor?: string | null): boolean {
    return getSteeringCapability(flavor) !== null
}

/**
 * Session-aware steer gate. Legacy Cursor stream-json sessions advertise
 * flavor `cursor` but cannot steer, including pre-ACP sessions with only an id.
 * Native admission and remote-control checks remain the caller's responsibility.
 */
export function isSteeringSupportedForSession(metadata?: SteeringSessionMetadata | null): boolean {
    const capability = getSteeringCapability(metadata?.flavor)
    return capability !== null && (capability.supportsSession?.(metadata ?? {}) ?? true)
}

/**
 * Whether the provider reports an active steerable turn. This does not imply
 * that the session is active, remotely controlled, or will accept a native steer.
 */
export function hasActiveSteeringTurn(session: SteeringSessionState): boolean {
    if (!isSteeringSupportedForSession(session.metadata)) return false
    return getSteeringCapability(session.metadata?.flavor)?.activeTurnState === 'thinking'
        ? session.thinking === true
        : session.agentState?.steeringActive === true
}

export function getPermissionModesForFlavor(flavor?: string | null): readonly PermissionMode[] {
    return traitsOf(flavor).permissionModes
}

export function isPermissionModeAllowedForFlavor(mode: PermissionMode, flavor?: string | null): boolean {
    return getPermissionModesForFlavor(flavor).includes(mode)
}
