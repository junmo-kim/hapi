import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useClaudeModels } from './useClaudeModels'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

const catalog = {
    success: true,
    availableModels: [{ value: 'opus', effortLevels: ['low'] }]
}

describe('useClaudeModels', () => {
    it('returns the machine catalog while enabled', async () => {
        const getMachineClaudeModels = vi.fn(async () => catalog)
        const api = { getMachineClaudeModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        const { result } = renderHook(() => useClaudeModels({ api, machineId: 'machine-1', enabled: true }), {
            wrapper: wrapper(queryClient)
        })

        await waitFor(() => expect(result.current.availableModels).toHaveLength(1))
    })

    it('does not hand a cached Claude catalog to a session of another agent on the same machine', () => {
        const getMachineClaudeModels = vi.fn(async () => catalog)
        const api = { getMachineClaudeModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        queryClient.setQueryData(queryKeys.machineClaudeModels('machine-1'), catalog)

        const { result } = renderHook(() => useClaudeModels({ api, machineId: 'machine-1', enabled: false }), {
            wrapper: wrapper(queryClient)
        })

        expect(result.current.availableModels).toEqual([])
        expect(getMachineClaudeModels).not.toHaveBeenCalled()
    })

    it('treats a failed discovery as no catalog', async () => {
        const getMachineClaudeModels = vi.fn(async () => ({
            success: false,
            error: 'Claude model discovery timed out',
            availableModels: catalog.availableModels
        }))
        const api = { getMachineClaudeModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        const { result } = renderHook(() => useClaudeModels({ api, machineId: 'machine-1', enabled: true }), {
            wrapper: wrapper(queryClient)
        })

        await waitFor(() => expect(queryClient.getQueryState(queryKeys.machineClaudeModels('machine-1'))?.status).toBe('success'))
        expect(result.current.availableModels).toEqual([])
    })
})
