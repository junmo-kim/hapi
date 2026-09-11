import HapiClient
import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// Render the real ChatModel → ChatTranscriptView → recycled UIKit rows, not an
/// inline ToolGroupBlockView specimen. HTTP is faked; SSE targets closed loopback.
@MainActor
final class ToolTranscriptPresentationTests: XCTestCase {
    private struct Harness: View {
        let model: ChatModel
        let theme: HapiTheme
        let size: DynamicTypeSize

        var body: some View {
            NavigationStack {
                ChatTranscriptView(model: model)
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        ChatComposerView(interactor: model.interactor)
                    }
                    .navigationTitle("HAPI · UI specimen")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .hapiTypography()
            .hapiTheme(theme)
            .environment(\.dynamicTypeSize, size)
            .environment(\.colorScheme, theme.isDark ? .dark : .light)
            .preferredColorScheme(theme.isDark ? .dark : .light)
        }
    }

    func testRealTranscriptKeepsExpandedGroupContiguousAndCompact() async throws {
        let credentials = InMemoryCredentialStore()
        let payload = Data(#"{"uid":1,"exp":4102444800,"ns":"test"}"#.utf8).base64EncodedString()
        try credentials.store(HubCredentials(hubUrl: "http://127.0.0.1:1", accessToken: "test", jwt: "e30.\(payload).test"))
        let hub = try XCTUnwrap(HubSession(hubUrl: "http://127.0.0.1:1/tool-transcript-\(UUID().uuidString)",
                                         credentialStore: credentials, performer: ToolTranscriptHTTP()))
        let model = ChatModel(session: hub, sessionId: "tool-transcript")
        defer { model.stop(); hub.shutdown() }
        model.start()
        try await eventually { !model.blocks.isEmpty && !model.isSyncingTail }
        let groups = model.blocks.compactMap { block -> ToolGroupBlock? in
            guard case .toolGroup(let group) = block else { return nil }
            return group
        }
        XCTAssertEqual(groups.map(\.tools.count), [42, 5])
        let first = try XCTUnwrap(groups.first)
        let last = try XCTUnwrap(groups.last)
        XCTAssertEqual(toolGroupTitle(first), "42 tool calls")
        model.expandedToolGroups[first.id] = false
        model.expandedToolGroups[last.id] = true

        let cases: [(String, HapiTheme, DynamicTypeSize, CGFloat)] = [
            ("light-transcript", .light, .large, 390),
            ("dark-transcript", .dark, .large, 390),
            ("small-transcript", .light, .large, 320),
            ("ax-transcript", .light, .accessibility3, 390),
        ]
        for (name, theme, size, width) in cases {
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 844)
            let host = UIHostingController(rootView: Harness(model: model, theme: theme, size: size))
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            host.view.layoutIfNeeded()
            let collection = try XCTUnwrap(findCollection(host.view))
            try await eventually { collection.numberOfItems(inSection: 0) == 11 }
            try await Task.sleep(for: .milliseconds(250))
            for index in 5...9 {
                let previous = try XCTUnwrap(collection.layoutAttributesForItem(at: IndexPath(item: index - 1, section: 0)))
                let current = try XCTUnwrap(collection.layoutAttributesForItem(at: IndexPath(item: index, section: 0)))
                XCTAssertEqual(current.frame.minY, previous.frame.maxY, accuracy: 0.5, "\(name): group segments must touch")
                XCTAssertEqual(current.frame.minX, previous.frame.minX, accuracy: 0.5)
                XCTAssertEqual(current.frame.width, previous.frame.width, accuracy: 0.5)
                XCTAssertGreaterThanOrEqual(current.frame.height, 44)
            }
            if size == .large {
                let top = try XCTUnwrap(collection.layoutAttributesForItem(at: IndexPath(item: 4, section: 0)))
                let bottom = try XCTUnwrap(collection.layoutAttributesForItem(at: IndexPath(item: 9, section: 0)))
                XCTAssertLessThanOrEqual(bottom.frame.maxY - top.frame.minY, 330, "Five tools and header should not fill the screen")
            } else {
                let imageRow = try XCTUnwrap(collection.layoutAttributesForItem(at: IndexPath(item: 8, section: 0)))
                XCTAssertGreaterThan(imageRow.frame.height, 60, "System-font tool rows must also scale, not just markdown")
            }
            try capture(window, name: name)
            model.expandedToolGroups[first.id] = true
            try await eventually { collection.numberOfItems(inSection: 0) == 53 }
            model.expandedToolGroups[first.id] = false
            try await eventually { collection.numberOfItems(inSection: 0) == 11 }
        }
    }

    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<150 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Transcript did not settle")
    }

    private func findCollection(_ view: UIView) -> UICollectionView? {
        if let collection = view as? UICollectionView { return collection }
        return view.subviews.lazy.compactMap(findCollection).first
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

private struct ToolTranscriptHTTP: HTTPPerforming {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        guard url.lastPathComponent == "messages" else {
            return (Data(#"{"error":"unused test endpoint"}"#.utf8),
                    HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: nil)!)
        }
        let after = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains { $0.name == "afterAt" } == true
        let rows = messages()
        let response = MessagesResponse(messages: after ? [] : rows, page: MessagesPage(
            direction: after ? .after : .latest, limit: 200, epoch: 1, reset: false,
            nextBeforeSeq: after ? nil : rows.first?.seq, nextBeforeAt: after ? nil : rows.first?.createdAt,
            nextAfterSeq: after ? rows.last?.seq : nil, nextAfterAt: after ? rows.last?.createdAt : nil,
            snapshotHeadSeq: rows.last?.seq, snapshotHeadAt: rows.last?.createdAt, hasMore: false
        ))
        return (try JSONEncoder().encode(response), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }

    private func messages() -> [DecryptedMessage] {
        var rows: [DecryptedMessage] = []
        func append(_ data: JSONValue) {
            let seq = rows.count + 1
            rows.append(DecryptedMessage(id: "row-\(seq)", seq: seq,
                content: ["role": "agent", "content": ["type": "codex", "data": data]],
                createdAt: seq * 1000, invokedAt: seq * 1000))
        }
        func tool(_ name: String, input: JSONValue, error: Bool = false) {
            let id = "tool-\(rows.count)"
            append(["type": "tool-call", "callId": .string(id), "name": .string(name), "input": input])
            append(["type": "tool-call-result", "callId": .string(id), "output": "Done", "is_error": .bool(error)])
        }
        append(["type": "message", "message": "工具详情独立阅读；关闭后保留聊天位置。"])
        for index in 0..<42 {
            if index < 17 { tool("Bash", input: ["command": "git diff --stat"], error: index == 0) }
            else if index < 23 { tool("Edit", input: ["file_path": "/workspace/ChatView.swift"]) }
            else { tool("exec", input: ["code": "await tools.exec_command({cmd: 'swift test'})"]) }
        }
        append(["type": "message", "message": "实现与测试已完成。正在核对浅色／深色 UI，并清理测试生成文件。"])
        tool("view_image", input: ["path": "/tmp/hapi-tool-inspector-review-20260911-final/light-summary.png"])
        tool("view_image", input: ["path": "/tmp/hapi-tool-inspector-review-20260911-final/dark-detail.png"])
        tool("Bash", input: ["command": "rm ios/Packages/HapiKit/Package.resolved && git diff --check && git status --short"])
        tool("exec", input: ["code": "await tools.mcp__hapi__display_image({path: '/tmp/light-summary.png'})"])
        tool("mcp__hapi__display_image", input: ["path": "/tmp/light-summary.png"])
        append(["type": "message", "message": "检查完成，可以继续对话。"])
        return rows
    }
}
