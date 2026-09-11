import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// Real UIKit sheet presentation over deterministic, non-networked content.
@MainActor
final class ToolInspectionPresentationTests: XCTestCase {
    private struct Harness: View {
        let inspection: ToolInspectionState
        let group: ToolGroupBlock
        let theme: HapiTheme
        var body: some View {
            let inspectorPresented = inspection.selection != nil
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("检查原生工具显示，并验证测试结果。")
                        ToolGroupBlockView(block: group, basePath: "/workspace/hapi", expansion: .constant(true))
                        Text("工具详情独立阅读；关闭后继续对话。")
                    }
                    .hapiReadingColumn().padding(.vertical, 16)
                }
                .background(theme.background)
                .navigationTitle("HAPI · UI specimen")
                .navigationBarTitleDisplayMode(.inline)
                .sheet(isPresented: Binding(get: { inspectorPresented }, set: { if !$0 { inspection.dismiss(owner: "chat") } })) {
                    ToolDetailSheet(inspection: inspection, basePath: "/workspace/hapi", openFile: { _ in })
                }
                .environment(\.openChatTool, { inspection.open($0, owner: "chat") })
            }
            .hapiTypography()
            .hapiTheme(theme)
            .preferredColorScheme(theme.isDark ? .dark : .light)
        }
    }

    func testSheetRemainsPresentedDuringSelectionAndLiveUpdates() async throws {
        let tools = [
            tool("read", name: "Read", input: ["file_path": .string("/workspace/hapi/ios/Hapi/Features/Chat/ChatView.swift")],
                 result: "import SwiftUI\n\n// 保持聊天上下文\nstruct ChatView: View {\n    var body: some View {\n        ChatTranscriptView(model: model)\n    }\n}"),
            tool("test", name: "Bash", input: ["command": .string("swift test --package-path ios/Packages/HapiKit")],
                 result: "Build complete.\n✓ Protocol fixtures\n✓ Tool inspection\n✓ Reading position\n\nAll tests passed."),
        ]
        let blocks = buildVisibleChatBlocks(tools.map(ChatBlock.toolCall), options: .init(hasMoreMessages: false))
        guard case .toolGroup(let group)? = blocks.first else { return XCTFail("Expected a tool group") }
        for (name, theme) in [("light", HapiTheme.light), ("dark", HapiTheme.dark)] {
            let inspection = ToolInspectionState()
            inspection.update(blocks)
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            let host = UIHostingController(rootView: Harness(inspection: inspection, group: group, theme: theme))
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(250))
            // Transcript screenshots live in ToolTranscriptPresentationTests,
            // which exercises the actual recycled ChatTranscriptView rows.
            inspection.open(tools[0], owner: "chat")
            try await Task.sleep(for: .milliseconds(600))
            let presented = try XCTUnwrap(host.presentedViewController)
            XCTAssertTrue(presented.presentationController is UISheetPresentationController)
            try capture(window, name: "\(name)-detail")
            inspection.move(by: 1)
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertTrue(host.presentedViewController === presented)
            var changed = tools[1]
            changed.tool.state = .error
            changed.tool.result = .string("A later test failed.")
            inspection.update(buildVisibleChatBlocks([.toolCall(tools[0]), .toolCall(changed)], options: .init(hasMoreMessages: false)))
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertTrue(host.presentedViewController === presented)
            XCTAssertEqual(inspection.selection?.block.tool.state, .error)
            inspection.dismiss(owner: "chat")
            for _ in 0..<100 {
                if host.presentedViewController == nil { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertNil(host.presentedViewController)
        }
    }

    private func tool(_ id: String, name: String, input: [String: JSONValue], result: String) -> ToolCallBlock {
        ToolCallBlock(id: id, localId: nil, createdAt: 0, invokedAt: nil, durationMs: nil, usage: nil, model: nil,
                      tool: ChatToolCall(id: id, name: name, state: .completed, input: .object(input), createdAt: 0, result: .string(result)),
                      children: [], meta: nil)
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_TOOL_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}
