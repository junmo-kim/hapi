@testable import HapiProtocol
import XCTest
@testable import Hapi

@MainActor
final class ToolInspectionTests: XCTestCase {
    private func block(_ id: String, result: String? = nil, children: [ChatBlock] = []) -> ToolCallBlock {
        ToolCallBlock(
            id: id, localId: nil, createdAt: 0, invokedAt: nil, durationMs: nil, usage: nil, model: nil,
            tool: ChatToolCall(id: id, name: "Bash", state: result == nil ? .running : .completed,
                              input: .object(["command": .string("echo \(id)")]), createdAt: 0,
                              result: result.map(JSONValue.string)),
            children: children, meta: nil
        )
    }

    private func grouped(_ tools: [ToolCallBlock]) -> [VisibleChatBlock] {
        buildVisibleChatBlocks(tools.map(ChatBlock.toolCall), options: .init(hasMoreMessages: false))
    }

    func testLiveResultAndGroupNavigationUseStableToolIdentity() throws {
        let inspector = ToolInspectionState()
        inspector.update(grouped([block("a"), block("b")]))
        inspector.open(block("a"), owner: "chat")
        XCTAssertEqual(inspector.siblingIDs, ["a", "b"])
        inspector.move(by: 1)
        XCTAssertEqual(inspector.selection?.block.id, "b")
        inspector.update(grouped([block("before"), block("a"), block("b", result: "finished")]))
        XCTAssertEqual(inspector.selection?.block.id, "b")
        XCTAssertEqual(inspector.selection?.block.tool.result, .string("finished"))
        XCTAssertEqual(inspector.selectedIndex, 2)
        inspector.move(by: 1)
        XCTAssertEqual(inspector.selection?.block.id, "b")
        inspector.move(by: -1)
        XCTAssertEqual(inspector.selection?.block.id, "a")
    }

    func testRegroupingAndTrimmingDoNotSubstituteAnotherTool() {
        let inspector = ToolInspectionState()
        inspector.update(grouped([block("a"), block("b", result: "original")]))
        inspector.open(block("b"), owner: "chat")
        inspector.update([.block(.toolCall(block("b", result: "latest")))])
        XCTAssertEqual(inspector.siblingIDs, ["b"])
        inspector.update(grouped([block("replacement"), block("other")]))
        XCTAssertTrue(inspector.isStale)
        XCTAssertEqual(inspector.selection?.block.tool.result, .string("latest"))
        XCTAssertTrue(inspector.siblingIDs.isEmpty)
        inspector.move(by: 1)
        XCTAssertEqual(inspector.selection?.block.id, "b")
    }

    func testNestedLookupOwnershipAndSessionInvalidation() {
        let inspector = ToolInspectionState()
        let nested = block("child")
        let parent = block("parent", children: [.toolCall(nested)])
        inspector.update([.block(.toolCall(parent))])
        XCTAssertTrue(opensToolProcess(parent))
        XCTAssertFalse(opensToolProcess(nested))
        inspector.open(nested, owner: "process:parent")
        XCTAssertFalse(inspector.isStale)
        inspector.dismiss(owner: "chat")
        XCTAssertNotNil(inspector.selection)
        inspector.invalidate()
        XCTAssertNil(inspector.selection)
        XCTAssertTrue(inspector.tools.isEmpty)
        XCTAssertEqual(inspector.invalidation, 1)
    }

    func testLongTextPagesPreserveFullUnicodePayload() {
        let text = String(repeating: "中👩🏽‍💻\n", count: 20_001) + "last line  \n"
        let pages = toolTextPages(text)
        XCTAssertGreaterThan(pages.count, 1)
        XCTAssertTrue(pages.allSatisfy { $0.count <= toolTextPageSize })
        XCTAssertEqual(pages.joined(), text)
        XCTAssertEqual(toolTextPages(""), [])
        XCTAssertEqual(toolTextPages("hello\n"), ["hello\n"])
    }

}
