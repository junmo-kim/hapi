import HapiProtocol
import HapiUI
import SwiftUI

/// A short activity count, with secondary category counts. Inline and recycled
/// transcript rows share the same segments so an expanded group stays connected.
struct ToolGroupBlockView: View {
    let block: ToolGroupBlock
    let basePath: String?

    @State private var expanded: Bool
    private let expansion: Binding<Bool>?
    private let showsTools: Bool
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    init(block: ToolGroupBlock, basePath: String?, expansion: Binding<Bool>? = nil, showsTools: Bool = true) {
        self.block = block
        self.basePath = basePath
        _expanded = State(initialValue: block.defaultOpen)
        self.expansion = expansion
        self.showsTools = showsTools
    }

    var body: some View {
        let isExpanded = expansion?.wrappedValue ?? expanded
        VStack(alignment: .leading, spacing: 0) {
            headerRow
                .modifier(ToolGroupSurface(isFirst: true, isLast: !isExpanded || block.tools.isEmpty))
            if showsTools && isExpanded {
                ForEach(block.tools, id: \.id) { tool in
                    ToolGroupChildRow(block: tool, basePath: basePath, isLast: tool.id == block.tools.last?.id)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headerRow: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                if let expansion { expansion.wrappedValue.toggle() }
                else { expanded.toggle() }
            }
        } label: {
            let layout = typography.usesStackedToolLayout
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "wrench.and.screwdriver")
                        .font(typography.toolSubtitleFont)
                        .foregroundStyle(theme.textSecondary)
                        .frame(width: typography.toolIconWidth)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(toolGroupTitle(block))
                            .font(typography.toolTitleFont)
                            .foregroundStyle(theme.textPrimary)
                            .lineLimit(typography.usesStackedToolLayout ? 2 : 1)
                            .fixedSize(horizontal: false, vertical: true)
                        if !categorySummary.isEmpty {
                            Text(categorySummary)
                                .font(typography.toolSubtitleFont)
                                .foregroundStyle(theme.textSecondary)
                                .lineLimit(typography.usesStackedToolLayout ? 2 : 1)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                if !typography.usesStackedToolLayout { Spacer(minLength: 8) }
                trailingIndicator
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue((expansion?.wrappedValue ?? expanded) ? String(localized: "Expanded") : String(localized: "Collapsed"))
        .accessibilityIdentifier("tool-group-\(block.id)")
    }

    private var categorySummary: String {
        let parts = ToolGroupActionKind.allCases.compactMap { kind -> String? in
            let count = block.summary.countsByKind[kind] ?? 0
            guard count > 0 else { return nil }
            let format: String
            switch kind {
            case .read: format = count == 1 ? String(localized: "1 read") : String(localized: "%lld reads")
            case .search: format = count == 1 ? String(localized: "1 search") : String(localized: "%lld searches")
            case .command: format = count == 1 ? String(localized: "1 command") : String(localized: "%lld commands")
            case .mutation: format = count == 1 ? String(localized: "1 edit") : String(localized: "%lld edits")
            case .web: format = count == 1 ? String(localized: "1 web request") : String(localized: "%lld web requests")
            case .other: format = count == 1 ? String(localized: "1 other tool") : String(localized: "%lld other tools")
            }
            return String(format: format, Int64(count))
        }
        return parts.joined(separator: " · ")
    }

    private var trailingIndicator: some View {
        HStack(spacing: 8) {
            if block.summary.runningCount > 0 {
                ProgressView().controlSize(.small)
                    .accessibilityLabel("Running")
            }
            if block.summary.errorCount > 0 {
                Label("\(block.summary.errorCount)", systemImage: "exclamationmark.circle")
                    .font(typography.toolSubtitleFont).foregroundStyle(.red)
                    .accessibilityLabel(String(format: String(localized: "%lld failed tools"), Int64(block.summary.errorCount)))
            }
            Image(systemName: (expansion?.wrappedValue ?? expanded) ? "chevron.down" : "chevron.right")
                .font(typography.captionFont).foregroundStyle(theme.textSecondary)
        }
    }
}

func toolGroupTitle(_ block: ToolGroupBlock) -> String {
    let count = block.summary.totalTools
    let title = count == 1 ? String(localized: "1 tool call")
        : String(format: String(localized: "%lld tool calls"), Int64(count))
    return block.activityTitle.map { "\($0) · \(title)" } ?? title
}

struct ToolGroupChildRow: View {
    let block: ToolCallBlock
    let basePath: String?
    let isLast: Bool

    var body: some View {
        ToolCallBlockView(block: block, basePath: basePath, compact: true)
            .modifier(ToolGroupSurface(isFirst: false, isLast: isLast))
    }
}

/// Corner ownership follows the group's live boundaries, not a recycled cell's
/// identity. No inter-row padding: the virtualized rows form one continuous card.
private struct ToolGroupSurface: ViewModifier {
    let isFirst: Bool
    let isLast: Bool
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    func body(content: Content) -> some View {
        content
            .background(theme.surface, in: UnevenRoundedRectangle(
                topLeadingRadius: isFirst ? 12 : 0,
                bottomLeadingRadius: isLast ? 12 : 0,
                bottomTrailingRadius: isLast ? 12 : 0,
                topTrailingRadius: isFirst ? 12 : 0
            ))
            .overlay(alignment: .top) {
                if !isFirst {
                    Rectangle().fill(theme.divider).frame(height: 0.5)
                        .padding(.leading, 12 + typography.toolIconWidth + 8).padding(.trailing, 12)
                }
            }
    }
}
