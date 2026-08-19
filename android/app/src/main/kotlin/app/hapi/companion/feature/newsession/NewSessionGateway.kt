package app.hapi.companion.feature.newsession

import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.SpawnResponse
import app.hapi.protocol.wire.SpawnSessionRequest

/**
 * The four machine endpoints the create form talks to, as a seam so JVM tests
 * drive [NewSessionViewModel] with fakes (the concrete [HapiApi] is final).
 */
interface NewSessionGateway {
    /** `POST /api/machines/:id/spawn` — check `type`, not HTTP status. */
    suspend fun spawn(machineId: String, request: SpawnSessionRequest): SpawnResponse

    /** `POST /api/machines/:id/list-directory` (RPC-wrapped). */
    suspend fun listDirectory(machineId: String, path: String): MachineListDirectoryResponse

    /** `POST /api/machines/:id/paths/exists`. */
    suspend fun pathsExist(machineId: String, paths: List<String>): Map<String, Boolean>

    /** `GET /api/machines/:id/codex-models` (RPC-wrapped; 503 `rpc_target_missing` = hide picker). */
    suspend fun codexModels(machineId: String): CodexModelsResponse
}

/** Production adapter over the hub's [HapiApi]. */
class ApiNewSessionGateway(private val api: HapiApi) : NewSessionGateway {
    override suspend fun spawn(machineId: String, request: SpawnSessionRequest): SpawnResponse =
        api.spawnSession(machineId, request)

    override suspend fun listDirectory(machineId: String, path: String): MachineListDirectoryResponse =
        api.listMachineDirectory(machineId, path)

    override suspend fun pathsExist(machineId: String, paths: List<String>): Map<String, Boolean> =
        api.checkMachinePathsExist(machineId, paths).exists

    override suspend fun codexModels(machineId: String): CodexModelsResponse =
        api.getMachineCodexModels(machineId)
}
