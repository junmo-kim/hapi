import HapiProtocol
import Observation
import SwiftUI

/// One inspector per chat, owned outside recycled transcript cells. Its
/// identity stays fixed while its selected tool is resolved from live data.
@MainActor @Observable
final class ToolInspectionState {
    struct Selection {
        let owner: String
        var block: ToolCallBlock
    }

    private(set) var tools: [String: ToolCallBlock] = [:]
    private var groups: [String: [String]] = [:]
    private(set) var selection: Selection?
    private(set) var invalidation = 0

    var isStale: Bool {
        guard let selection else { return false }
        return tools[selection.block.id] == nil
    }

    var siblingIDs: [String] {
        guard let selection, !isStale else { return [] }
        return groups[selection.block.id] ?? [selection.block.id]
    }

    var selectedIndex: Int? {
        guard let selection else { return nil }
        return siblingIDs.firstIndex(of: selection.block.id)
    }

    func update(_ blocks: [VisibleChatBlock]) {
        var nextTools: [String: ToolCallBlock] = [:]
        var nextGroups: [String: [String]] = [:]
        func collect(_ block: ChatBlock) {
            guard case .toolCall(let tool) = block else { return }
            nextTools[tool.id] = tool
            tool.children.forEach(collect)
        }
        for block in blocks {
            switch block {
            case .block(let value): collect(value)
            case .toolGroup(let group):
                let ids = group.tools.map(\.id)
                for tool in group.tools {
                    nextGroups[tool.id] = ids
                    collect(.toolCall(tool))
                }
            }
        }
        if tools != nextTools { tools = nextTools }
        if groups != nextGroups { groups = nextGroups }
        if let selected = selection, let latest = nextTools[selected.block.id], latest != selected.block {
            selection = Selection(owner: selected.owner, block: latest)
        }
    }

    func open(_ block: ToolCallBlock, owner: String) {
        selection = Selection(owner: owner, block: tools[block.id] ?? block)
    }

    func dismiss(owner: String) {
        if selection?.owner == owner { selection = nil }
    }

    func move(by offset: Int) {
        guard let selection, let index = selectedIndex else { return }
        let ids = siblingIDs
        let next = index + offset
        guard ids.indices.contains(next), let block = tools[ids[next]] else { return }
        self.selection = Selection(owner: selection.owner, block: block)
    }

    func invalidate() {
        selection = nil
        tools = [:]
        groups = [:]
        invalidation += 1
    }
}

func opensToolProcess(_ block: ToolCallBlock) -> Bool {
    !block.children.isEmpty || isSubagentToolName(block.tool.name) || block.tool.name == "CodexAgent"
}

private struct OpenChatToolKey: EnvironmentKey {
    static let defaultValue: (@MainActor (ToolCallBlock) -> Void)? = nil
}

extension EnvironmentValues {
    var openChatTool: (@MainActor (ToolCallBlock) -> Void)? {
        get { self[OpenChatToolKey.self] }
        set { self[OpenChatToolKey.self] = newValue }
    }
}
