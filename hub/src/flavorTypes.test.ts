import { withNativeSessionId, type AgentFlavor, type NativeIdFieldOf, type NativeIdFlavor } from '@hapi/protocol'
import type { Metadata } from '@hapi/protocol/types'

// Compile-time checks of the @hapi/protocol flavor declarations. They live in a
// hub file because shared tests are not typechecked; `bun typecheck` covers this one.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

type EveryFlavorDeclaresANativeIdField = Expect<Equal<NativeIdFlavor, AgentFlavor>>
type DeclaredNativeIdFields = Expect<Equal<{ [K in NativeIdFlavor]: NativeIdFieldOf<K> }, {
    agy: 'agySessionId'
    claude: 'claudeSessionId'
    codex: 'codexSessionId'
    dsh: 'dshSessionId'
    copilot: 'copilotSessionId'
    cursor: 'cursorSessionId'
    gemini: 'geminiSessionId'
    grok: 'grokSessionId'
    kimi: 'kimiSessionId'
    opencode: 'opencodeSessionId'
    pi: 'piSessionId'
}>>

// Never called; only compiled.
function nativeSessionIdWriterTypes(): void {
    const metadata: Metadata = { path: '/p', host: 'h' }
    const withKimi: { kimiSessionId: string } = withNativeSessionId(metadata, 'kimi', 'k-1')
    const withCursor: { cursorSessionId: string } = withNativeSessionId(metadata, 'cursor', 'cu-1')

    // @ts-expect-error: an unregistered flavor declares no native id field.
    withNativeSessionId(metadata, 'unknown', 'x')
    // @ts-expect-error: null declares no native id field.
    withNativeSessionId(metadata, null, 'x')
    // @ts-expect-error: undefined declares no native id field.
    withNativeSessionId(metadata, undefined, 'x')

    void withKimi
    void withCursor
}
void nativeSessionIdWriterTypes
