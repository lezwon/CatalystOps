package com.catalystops.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.project.Project

@Service(Service.Level.PROJECT)
@State(
    name = "DatabricksSettings",
    storages = [Storage(StoragePathMacros.WORKSPACE_FILE)]
)
class DatabricksSettings : PersistentStateComponent<DatabricksSettings.State> {

    data class State(
        var host: String = "",
        var token: String = "",
        var clusterId: String = "",
        var executionMode: String = "cluster",  // "cluster" | "serverless"
        var timeoutSeconds: Int = 300,
        var warehouseId: String = "",           // SQL warehouse ID for billing (blank = auto-discover)
        var dbuRatePerHour: Double = 0.4,       // DBU cost rate for estimation
        var serverlessRatePerHour: Double = 0.7 // Serverless DBU cost rate
    )

    private var myState = State()

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
    }

    companion object {
        fun getInstance(project: Project): DatabricksSettings =
            project.getService(DatabricksSettings::class.java)
    }
}
