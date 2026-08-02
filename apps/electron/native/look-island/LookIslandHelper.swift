// ============================================================
// LookIslandHelper — macOS native Look Island renderer
//
// Top-level script compiled with `swiftc -O`. Spawned by the Electron
// main process (see src/main/look-island/native-host.ts). Communicates
// over stdin/stdout with newline-delimited JSON.
//
// Product state stays in TypeScript; this helper only renders the
// NSPanel notch UI, detects the hardware notch, and reports native
// events (hover / expand / focus-session / outside-click / content-height)
// back to main.
// ============================================================

import AppKit
import Foundation
import SwiftUI

// MARK: - Metrics (mirrors packages/shared/src/types/look-island.ts)

private enum LookIslandMetrics {
  static let closedHeight: CGFloat = 34
  static let compactIdleWidth: CGFloat = 260
  static let compactActiveWidth: CGFloat = 340
  static let compactMinWidth: CGFloat = 80
  static let carrierInset: CGFloat = 20
  static let screenEdgeGutter: CGFloat = 112
  static let hardwareExtraWidth: CGFloat = 128
  static let simulatedNotchWidthRatio: CGFloat = 0.14
  static let simulatedNotchMinWidth: CGFloat = 160
  static let simulatedNotchMaxWidth: CGFloat = 240
  static let compactSimulatedActiveExtraWidth: CGFloat = 128
  static let shadowBottomMargin: CGFloat = 20
  static let expandedMaxWidth: CGFloat = 640
  static let expandedMinWidth: CGFloat = 360
  static let expandedMaxHeight: CGFloat = 560
  static let expandedMinHeight: CGFloat = 118
  static let expandedTopBarHeight: CGFloat = 26
  static let expandedRowHeight: CGFloat = 44
  static let expandedVerticalPadding: CGFloat = 16
  static let expandedMaxVisibleRows = 5
  static let expandedSideInset: CGFloat = 10
}

// MARK: - Status colors (aligned with LOOK themes/colors.ts)

private let lookIslandOrange = Color(red: 1.0, green: 0.4, blue: 0.0) // running
private let lookIslandBlue = Color(red: 0.0, green: 0.851, blue: 0.773) // needs-interaction
private let lookIslandErrorRed = Color(red: 0.937, green: 0.267, blue: 0.267)
private let lookIslandUnreadGreen = Color(red: 0.133, green: 0.773, blue: 0.369)
private let lookIslandIdleGray = Color(white: 0.45)
private let lookIslandWarningOrange = Color(red: 0.98, green: 0.67, blue: 0.22) // context near limit

// MARK: - Wire types (Codable mirrors of the TS contract)

struct LookIslandRect: Codable, Equatable {
  var x: Double
  var y: Double
  var width: Double
  var height: Double
}

struct LookIslandActivityLine: Codable, Equatable, Identifiable {
  var id: String
  var kind: String
  var text: String
}

struct LookIslandSubagentSnapshot: Codable, Equatable, Identifiable {
  var toolCallId: String
  var agentName: String
  var taskTitle: String
  var status: String
  var model: String?

  var id: String { toolCallId }
}

struct LookIslandSessionSnapshot: Codable, Equatable, Identifiable {
  var sessionId: String
  var title: String?
  var projectName: String?
  var detail: String
  var phase: String
  var modelLabel: String?
  var interactionKind: String?
  var permissionToolName: String?
  var attention: Bool
  var activityLines: [LookIslandActivityLine]
  var subagents: [LookIslandSubagentSnapshot]?
  var usagePercent: Double?
  var startedAt: Double
  var lastActivityAt: Double

  var id: String { sessionId }
}

struct LookIslandPillSnapshot: Codable, Equatable {
  var phase: String
  var priorityTitle: String
  var sessionCount: Int
  var activeSessionCount: Int
  var pendingInteractionCount: Int
  var unreadCompletedCount: Int
  var usageWarning: Bool
}

struct LookIslandStrings: Codable, Equatable {
  var appName: String
  var running: String
  var completed: String
  var error: String
  var needsInput: String
  var settings: String
  var permissionPromptTitle: String
  var allowOnce: String
  var alwaysAllow: String
  var deny: String
  var planReviewTitle: String
  var approve: String
  var reject: String
}

struct LookIslandScreenMetrics: Codable, Equatable {
  var displayId: Int
  var frame: LookIslandRect
  var hasNotch: Bool
  var notchWidth: Double
  var topBarHeight: Double
  var menuBarHeight: Double
  var safeAreaTop: Double
  var isMain: Bool
  var signature: String

  static let fallback = LookIslandScreenMetrics(
    displayId: 0,
    frame: LookIslandRect(x: 0, y: 0, width: 1440, height: 900),
    hasNotch: false,
    notchWidth: 210,
    topBarHeight: 24,
    menuBarHeight: 24,
    safeAreaTop: 0,
    isMain: true,
    signature: "fallback"
  )

  var dictionary: [String: Any] {
    [
      "displayId": displayId,
      "frame": [
        "x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height,
      ],
      "hasNotch": hasNotch,
      "notchWidth": notchWidth,
      "topBarHeight": topBarHeight,
      "menuBarHeight": menuBarHeight,
      "safeAreaTop": safeAreaTop,
      "isMain": isMain,
      "signature": signature,
    ]
  }
}

struct LookIslandNativeFrame: Codable, Equatable {
  var displayId: Int
  var displayBounds: LookIslandRect
  var contentWidth: Double?
  var centerXRatio: Double?
}

enum LookIslandInteraction: Codable, Equatable {
  case permission(requestId: String, sessionId: String, toolName: String, toolDescription: String, canAllowForSession: Bool)
  case plan(requestId: String, sessionId: String, title: String)

  var requestId: String {
    switch self {
    case .permission(let id, _, _, _, _): return id
    case .plan(let id, _, _): return id
    }
  }

  private enum CodingKeys: String, CodingKey {
    case kind, requestId, sessionId, toolName, toolDescription, canAllowForSession, title
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try container.decode(String.self, forKey: .kind)
    switch kind {
    case "permission":
      self = .permission(
        requestId: try container.decode(String.self, forKey: .requestId),
        sessionId: try container.decode(String.self, forKey: .sessionId),
        toolName: try container.decode(String.self, forKey: .toolName),
        toolDescription: try container.decode(String.self, forKey: .toolDescription),
        canAllowForSession: try container.decode(Bool.self, forKey: .canAllowForSession)
      )
    case "plan":
      self = .plan(
        requestId: try container.decode(String.self, forKey: .requestId),
        sessionId: try container.decode(String.self, forKey: .sessionId),
        title: try container.decode(String.self, forKey: .title)
      )
    default:
      throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "unknown interaction kind")
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .permission(let requestId, let sessionId, let toolName, let toolDescription, let canAllowForSession):
      try container.encode("permission", forKey: .kind)
      try container.encode(requestId, forKey: .requestId)
      try container.encode(sessionId, forKey: .sessionId)
      try container.encode(toolName, forKey: .toolName)
      try container.encode(toolDescription, forKey: .toolDescription)
      try container.encode(canAllowForSession, forKey: .canAllowForSession)
    case .plan(let requestId, let sessionId, let title):
      try container.encode("plan", forKey: .kind)
      try container.encode(requestId, forKey: .requestId)
      try container.encode(sessionId, forKey: .sessionId)
      try container.encode(title, forKey: .title)
    }
  }
}

struct LookIslandDisplayState: Codable, Equatable {
  var visible: Bool
  var mode: String
  var notchStatus: String
  var displayPolicy: String
  var currentSessionId: String?
  var pillSnapshot: LookIslandPillSnapshot
  var sessions: [LookIslandSessionSnapshot]
  var interaction: LookIslandInteraction?
  var strings: LookIslandStrings
  var updatedAt: Double

  static let empty = LookIslandDisplayState(
    visible: false,
    mode: "compact",
    notchStatus: "closed",
    displayPolicy: "closed",
    currentSessionId: nil,
    pillSnapshot: LookIslandPillSnapshot(
      phase: "idle", priorityTitle: "", sessionCount: 0,
      activeSessionCount: 0, pendingInteractionCount: 0, unreadCompletedCount: 0,
      usageWarning: false
    ),
    sessions: [],
    interaction: nil,
    strings: LookIslandStrings(
      appName: "Look", running: "Running", completed: "Completed",
      error: "Error", needsInput: "Needs input", settings: "Settings",
      permissionPromptTitle: "Confirm permission", allowOnce: "Allow once",
      alwaysAllow: "Always allow", deny: "Deny", planReviewTitle: "Review plan",
      approve: "Approve", reject: "Reject"
    ),
    updatedAt: 0
  )
}

/// Incoming stdin message — decoded leniently by `type` first.
private struct RawIncomingMessage: Codable {
  let type: String
  let protocolVersion: Int?
  let state: LookIslandDisplayState?
  let frame: LookIslandNativeFrame?
}

// MARK: - Output helper

func emitJson(_ payload: [String: Any]) {
  do {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  } catch {
    let fallback = "{\"type\":\"error\",\"message\":\"Could not encode look island event.\"}\n"
    FileHandle.standardError.write(Data(fallback.utf8))
  }
  fflush(stdout)
}

func emitScreenMetrics() {
  var payload: [String: Any] = [
    "type": "screen-metrics",
    "screens": LookIslandScreenMetricsProvider.allMetrics().map { $0.dictionary },
    "forceRefresh": false,
  ]
  payload["preferredDisplayId"] = LookIslandScreenMetricsProvider.preferredDisplayId()
  emitJson(payload)
}

// MARK: - Screen metrics provider

private enum LookIslandScreenMetricsProvider {
  static func allMetrics() -> [LookIslandScreenMetrics] {
    NSScreen.screens.map { metrics(for: $0) }
  }

  static func metrics(for screen: NSScreen?) -> LookIslandScreenMetrics {
    guard let screen else { return .fallback }
    let frame = screen.frame.integral
    let menuBarHeight = max(0, screen.frame.maxY - screen.visibleFrame.maxY)
    let safeAreaTop: CGFloat
    if #available(macOS 12.0, *) {
      safeAreaTop = screen.safeAreaInsets.top
    } else {
      safeAreaTop = 0
    }
    return LookIslandScreenMetrics(
      displayId: displayId(for: screen),
      frame: LookIslandRect(
        x: Double(frame.minX), y: Double(frame.minY),
        width: Double(frame.width), height: Double(frame.height)
      ),
      hasNotch: screenHasNotch(screen),
      notchWidth: Double(notchWidth(for: screen)),
      topBarHeight: Double(topBarHeight(menuBarHeight: menuBarHeight, safeAreaTop: safeAreaTop)),
      menuBarHeight: Double(menuBarHeight),
      safeAreaTop: Double(safeAreaTop),
      isMain: NSScreen.main == screen,
      signature: signature(for: screen)
    )
  }

  static func screenHasNotch(_ screen: NSScreen) -> Bool {
    if #available(macOS 12.0, *) {
      return screen.auxiliaryTopLeftArea != nil || screen.auxiliaryTopRightArea != nil
    }
    return false
  }

  static func notchWidth(for screen: NSScreen) -> CGFloat {
    if #available(macOS 12.0, *) {
      if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
        // Geometric cutout width — the physical notch is bounded by the two
        // auxiliary areas, so measure between them rather than subtracting
        // widths from the frame (survives asymmetric/misaligned areas).
        return max(1, right.minX - left.maxX)
      }
    }
    return simulatedNotchWidth(for: screen)
  }

  /// Screen-space X of the physical notch center, or nil when the screen
  /// has no hardware notch. The panel must anchor to this, not the screen
  /// center — notch placement can be a few pixels off-center on some Macs.
  static func notchCenterX(for screen: NSScreen?) -> CGFloat? {
    guard let screen, #available(macOS 12.0, *), screenHasNotch(screen) else { return nil }
    if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
      return (left.maxX + right.minX) / 2
    }
    return nil
  }

  static func displayId(for screen: NSScreen) -> Int {
    (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
  }

  static func signature(for screen: NSScreen) -> String {
    let frame = screen.frame.integral
    return "\(Int(frame.minX)):\(Int(frame.minY)):\(Int(frame.width)):\(Int(frame.height)):\(displayId(for: screen))"
  }

  static func preferredDisplayId() -> Int? {
    guard let screen = preferredScreen() else { return nil }
    return displayId(for: screen)
  }

  static func preferredScreen() -> NSScreen? {
    let screens = NSScreen.screens
    guard !screens.isEmpty else { return NSScreen.main }
    if let notchedScreen = screens.first(where: { screenHasNotch($0) }) {
      return notchedScreen
    }
    return NSScreen.main ?? screens.first
  }

  private static func topBarHeight(menuBarHeight: CGFloat, safeAreaTop: CGFloat) -> CGFloat {
    if safeAreaTop > 0 { return safeAreaTop }
    if menuBarHeight > 5 { return menuBarHeight }
    if let main = NSScreen.main {
      let mainMenuBarHeight = main.frame.maxY - main.visibleFrame.maxY
      if mainMenuBarHeight > 5 { return mainMenuBarHeight }
    }
    return 25
  }

  private static func simulatedNotchWidth(for screen: NSScreen) -> CGFloat {
    min(
      LookIslandMetrics.simulatedNotchMaxWidth,
      max(
        LookIslandMetrics.simulatedNotchMinWidth,
        screen.frame.width * LookIslandMetrics.simulatedNotchWidthRatio
      )
    )
  }
}

// MARK: - Model

final class LookIslandModel: ObservableObject {
  @Published var state = LookIslandDisplayState.empty
  @Published var screenMetrics = LookIslandScreenMetrics.fallback
  @Published var locallyHovered = false
  @Published var preferredContentWidth: CGFloat?
  @Published var pillContentWidth: CGFloat = 0
  /// Called when the compact pill's measured natural width changes; the
  /// controller widens the panel so content is never clipped.
  var onPillContentWidthMeasured: ((CGFloat) -> Void)?
}

/// Measured natural width of the compact pill content (status dot + notch gap
/// + badge). The controller widens the panel to fit when content exceeds the
/// default width, so the badge is never clipped by the hardware notch.
private struct LookIslandPillWidthPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}

// MARK: - Status helpers

private func statusColor(for phase: String) -> Color {
  switch phase {
  case "running": return lookIslandOrange
  case "needs-interaction": return lookIslandBlue
  case "completed": return lookIslandUnreadGreen
  case "error": return lookIslandErrorRed
  default: return lookIslandIdleGray
  }
}

// MARK: - Compact pill

private struct LookIslandPillView: View {
  let state: LookIslandDisplayState
  let height: CGFloat
  let hasHardwareNotch: Bool
  let notchWidth: CGFloat
  let onContentWidth: (CGFloat) -> Void

  private var phase: String { state.pillSnapshot.phase }
  private var hasSession: Bool { badgeCount > 0 }

  private var title: String {
    if !state.pillSnapshot.priorityTitle.isEmpty {
      return state.pillSnapshot.priorityTitle
    }
    switch phase {
    case "running": return state.strings.running
    case "needs-interaction": return state.strings.needsInput
    case "completed": return state.strings.completed
    case "error": return state.strings.error
    default: return state.strings.appName
    }
  }

  var body: some View {
    ZStack {
      HStack(spacing: 6) {
        if hasHardwareNotch {
          Circle()
            .fill(statusColor)
            .frame(width: 6, height: 6)
            .shadow(color: statusColor.opacity(0.8), radius: 3)
          Spacer(minLength: 0)
            .frame(width: notchWidth)
          Spacer(minLength: 0)
          if hasSession {
            Text(badgeText)
              .font(.system(size: 10, weight: .semibold, design: .monospaced))
              .foregroundColor(.white.opacity(0.9))
              .padding(.horizontal, 5)
              .padding(.vertical, 1.5)
              .background(Capsule().fill(Color.white.opacity(0.14)))
          }
        } else {
          Circle()
            .fill(statusColor)
            .frame(width: 6, height: 6)
            .shadow(color: statusColor.opacity(0.8), radius: 3)
          if hasSession {
            Text(badgeText)
              .font(.system(size: 10, weight: .semibold, design: .monospaced))
              .foregroundColor(.white.opacity(0.9))
              .padding(.horizontal, 5)
              .padding(.vertical, 1.5)
              .background(Capsule().fill(Color.white.opacity(0.14)))
          }
        }
      }
      .padding(.horizontal, 12)
      .frame(height: height)
      .fixedSize(horizontal: true, vertical: false)
      .background(
        Capsule()
          .fill(Color.black)
          .shadow(color: Color.black.opacity(0.35), radius: 8, x: 0, y: 3)
      )
      .overlay(
        Capsule().strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
      )
      .background(
        GeometryReader { proxy in
          Color.clear.preference(key: LookIslandPillWidthPreferenceKey.self, value: proxy.size.width)
        }
      )
      .onPreferenceChange(LookIslandPillWidthPreferenceKey.self) { measured in
        if measured > 0 {
          onContentWidth(measured)
        }
      }
    }
  }

  private var statusColor: Color {
    if state.pillSnapshot.usageWarning && phase != "needs-interaction" && phase != "error" {
      return lookIslandWarningOrange
    }
    switch phase {
    case "running": return lookIslandOrange
    case "needs-interaction": return lookIslandBlue
    case "completed": return lookIslandUnreadGreen
    case "error": return lookIslandErrorRed
    default: return lookIslandIdleGray
    }
  }

  /// Worth-noting sessions: currently running + unread (not yet viewed by
  /// the user). Viewed completed sessions do not count toward the badge.
  private var badgeCount: Int {
    state.pillSnapshot.activeSessionCount + state.pillSnapshot.unreadCompletedCount
  }

  private var badgeText: String {
    "\(badgeCount)"
  }
}

// MARK: - Notch shape (pill → card morphing)

struct LookIslandNotchShape: Shape {
  var topExtension: CGFloat
  var bottomRadius: CGFloat
  var minHeight: CGFloat

  var animatableData: AnimatablePair<CGFloat, CGFloat> {
    get { AnimatablePair(topExtension, bottomRadius) }
    set {
      topExtension = newValue.first
      bottomRadius = newValue.second
    }
  }

  func path(in rect: CGRect) -> Path {
    let ext = topExtension
    let maxY = max(rect.maxY, rect.minY + minHeight)
    let br = min(bottomRadius, rect.width / 4, (maxY - rect.minY) / 2)
    let k: CGFloat = 0.62

    var path = Path()
    path.move(to: CGPoint(x: rect.minX - ext, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX + ext, y: rect.minY))
    path.addCurve(
      to: CGPoint(x: rect.maxX, y: rect.minY + ext),
      control1: CGPoint(x: rect.maxX + ext * 0.35, y: rect.minY),
      control2: CGPoint(x: rect.maxX, y: rect.minY + ext * 0.35)
    )
    path.addLine(to: CGPoint(x: rect.maxX, y: maxY - br))
    path.addCurve(
      to: CGPoint(x: rect.maxX - br, y: maxY),
      control1: CGPoint(x: rect.maxX, y: maxY - br * (1 - k)),
      control2: CGPoint(x: rect.maxX - br * (1 - k), y: maxY)
    )
    path.addLine(to: CGPoint(x: rect.minX + br, y: maxY))
    path.addCurve(
      to: CGPoint(x: rect.minX, y: maxY - br),
      control1: CGPoint(x: rect.minX + br * (1 - k), y: maxY),
      control2: CGPoint(x: rect.minX, y: maxY - br * (1 - k))
    )
    path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + ext))
    path.addCurve(
      to: CGPoint(x: rect.minX - ext, y: rect.minY),
      control1: CGPoint(x: rect.minX, y: rect.minY + ext * 0.35),
      control2: CGPoint(x: rect.minX - ext * 0.35, y: rect.minY)
    )
    path.closeSubpath()
    return path
  }
}

// MARK: - Expanded card

private struct LookIslandExpandedCardView: View {
  let state: LookIslandDisplayState
  let width: CGFloat
  let height: CGFloat
  let topExtension: CGFloat
  let bottomRadius: CGFloat
  let hasHardwareNotch: Bool
  let notchWidth: CGFloat
  let onFocusSession: (String) -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text(state.strings.appName)
          .font(.system(size: 11, weight: .semibold))
          .foregroundColor(.white.opacity(0.7))
        if hasHardwareNotch {
          Spacer(minLength: 0)
            .frame(width: notchWidth)
          Spacer(minLength: 0)
        } else {
          Spacer()
        }
        Text(sessionSummary)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundColor(.white.opacity(0.5))
      }
      .frame(height: LookIslandMetrics.expandedTopBarHeight)
      .padding(.horizontal, LookIslandMetrics.expandedSideInset + 6)

      if let queue = visibleSubagentQueue {
        LookIslandSubagentQueueView(subagents: queue)
          .padding(.horizontal, LookIslandMetrics.expandedSideInset + 8)
          .padding(.bottom, 4)
      }

      ForEach(visibleSessions) { session in
        LookIslandSessionRow(session: session, strings: state.strings)
          .contentShape(Rectangle())
          .onTapGesture { onFocusSession(session.sessionId) }
      }
    }
    .padding(.top, 4)
    .padding(.bottom, LookIslandMetrics.expandedVerticalPadding)
    .frame(width: width, height: height, alignment: .top)
    .background(
      LookIslandNotchShape(
        topExtension: topExtension,
        bottomRadius: bottomRadius,
        minHeight: LookIslandMetrics.closedHeight
      )
      .fill(Color.black)
      .shadow(color: Color.black.opacity(0.4), radius: 14, x: 0, y: 6)
    )
    .overlay(
      LookIslandNotchShape(
        topExtension: topExtension,
        bottomRadius: bottomRadius,
        minHeight: LookIslandMetrics.closedHeight
      )
      .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
    )
  }

  private var visibleSessions: [LookIslandSessionSnapshot] {
    Array(state.sessions.prefix(LookIslandMetrics.expandedMaxVisibleRows))
  }

  private var visibleSubagentQueue: [LookIslandSubagentSnapshot]? {
    guard let current = state.currentSessionId,
          let session = state.sessions.first(where: { $0.sessionId == current }),
          let subagents = session.subagents,
          !subagents.isEmpty else {
      return nil
    }
    let active = subagents.filter { $0.status == "running" }
    let recent = subagents.filter { $0.status != "running" }
    let ordered = active + recent.prefix(1)
    return Array(ordered.prefix(3))
  }

  private var sessionSummary: String {
    "\(state.pillSnapshot.sessionCount) sessions"
  }
}

private struct LookIslandSubagentQueueView: View {
  let subagents: [LookIslandSubagentSnapshot]

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      ForEach(subagents) { subagent in
        LookIslandSubagentRow(subagent: subagent)
      }
    }
    .padding(8)
    .background(
      RoundedRectangle(cornerRadius: 8)
        .fill(Color.white.opacity(0.06))
    )
  }
}

private struct LookIslandSubagentRow: View {
  let subagent: LookIslandSubagentSnapshot

  private var color: Color {
    switch subagent.status {
    case "running": return lookIslandOrange
    case "completed": return lookIslandUnreadGreen
    case "failed": return lookIslandErrorRed
    default: return lookIslandIdleGray
    }
  }

  private var statusText: String {
    switch subagent.status {
    case "running": return "…"
    case "completed": return "✓"
    case "failed": return "!"
    default: return "·"
    }
  }

  var body: some View {
    HStack(spacing: 6) {
      Text(statusText)
        .font(.system(size: 11, weight: .bold))
        .foregroundColor(color)
        .frame(width: 14, alignment: .leading)
      Text(subagent.taskTitle.isEmpty ? subagent.agentName : subagent.taskTitle)
        .font(.system(size: 10, weight: .medium))
        .foregroundColor(.white.opacity(0.85))
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 4)
      if subagent.status == "running" {
        ProgressView()
          .controlSize(.mini)
          .tint(lookIslandOrange)
          .scaleEffect(0.7)
      }
    }
  }
}

private struct LookIslandSessionRow: View {
  let session: LookIslandSessionSnapshot
  let strings: LookIslandStrings

  private var title: String {
    session.title?.isEmpty == false ? session.title! : (session.projectName ?? "Session")
  }

  private var detail: String {
    if session.phase == "needs-interaction" {
      return strings.needsInput
    }
    return session.detail
  }

  var body: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(statusColor(for: session.phase))
        .frame(width: 6, height: 6)
        .shadow(color: statusColor(for: session.phase).opacity(0.7), radius: 2)

      VStack(alignment: .leading, spacing: 1) {
        Text(title)
          .font(.system(size: 12, weight: .medium))
          .foregroundColor(.white)
          .lineLimit(1)
          .truncationMode(.tail)
        Text(detail)
          .font(.system(size: 10))
          .foregroundColor(.white.opacity(0.55))
          .lineLimit(1)
          .truncationMode(.tail)
      }

      Spacer(minLength: 8)

      if let usage = session.usagePercent, usage >= 85 {
        Text("\(Int(usage))%")
          .font(.system(size: 9, weight: .semibold, design: .monospaced))
          .foregroundColor(lookIslandWarningOrange)
          .padding(.horizontal, 5)
          .padding(.vertical, 2)
          .background(Capsule().fill(lookIslandWarningOrange.opacity(0.16)))
      }

      if let model = session.modelLabel, !model.isEmpty {
        Text(model)
          .font(.system(size: 9, weight: .semibold))
          .foregroundColor(.white.opacity(0.75))
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(Color.white.opacity(0.12)))
      }

      Image(systemName: "chevron.right")
        .font(.system(size: 9, weight: .semibold))
        .foregroundColor(.white.opacity(0.35))
    }
    .padding(.horizontal, LookIslandMetrics.expandedSideInset + 8)
    .frame(height: LookIslandMetrics.expandedRowHeight)
    .contentShape(Rectangle())
  }
}

// MARK: - Blocking interaction card (permission / plan approval)

private struct LookIslandBlockingCardView: View {
  let state: LookIslandDisplayState
  let width: CGFloat
  let height: CGFloat
  let topExtension: CGFloat
  let bottomRadius: CGFloat
  let onPermissionAction: (String, String) -> Void
  let onPlanAction: (String, String, String) -> Void

  var body: some View {
    VStack(spacing: 0) {
      header
      content
    }
    .frame(width: width, height: height, alignment: .top)
    .background(
      LookIslandNotchShape(
        topExtension: topExtension,
        bottomRadius: bottomRadius,
        minHeight: LookIslandMetrics.closedHeight
      )
      .fill(Color.black)
      .shadow(color: Color.black.opacity(0.4), radius: 14, x: 0, y: 6)
    )
    .overlay(
      LookIslandNotchShape(
        topExtension: topExtension,
        bottomRadius: bottomRadius,
        minHeight: LookIslandMetrics.closedHeight
      )
      .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
    )
  }

  private var header: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(lookIslandBlue)
        .frame(width: 6, height: 6)
      Text(headerTitle)
        .font(.system(size: 11, weight: .semibold))
        .foregroundColor(.white.opacity(0.8))
      Spacer()
      Text("requires your input")
        .font(.system(size: 10))
        .foregroundColor(.white.opacity(0.4))
    }
    .frame(height: LookIslandMetrics.expandedTopBarHeight)
    .padding(.horizontal, LookIslandMetrics.expandedSideInset + 8)
    .padding(.top, 6)
  }

  @ViewBuilder
  private var content: some View {
    switch state.interaction {
    case .permission(let requestId, _, let toolName, let toolDescription, let canAllowForSession):
      VStack(alignment: .leading, spacing: 8) {
        Text(toolName)
          .font(.system(size: 13, weight: .semibold, design: .monospaced))
          .foregroundColor(.white)
          .lineLimit(1)
        if !toolDescription.isEmpty {
          Text(toolDescription)
            .font(.system(size: 11))
            .foregroundColor(.white.opacity(0.6))
            .lineLimit(2)
        }
        HStack(spacing: 6) {
          LookIslandActionButton(title: state.strings.allowOnce, style: .primary) {
            onPermissionAction(requestId, "allow")
          }
          if canAllowForSession {
            LookIslandActionButton(title: state.strings.alwaysAllow, style: .secondary) {
              onPermissionAction(requestId, "allowForSession")
            }
          }
          LookIslandActionButton(title: state.strings.deny, style: .danger) {
            onPermissionAction(requestId, "deny")
          }
        }
        .frame(maxWidth: .infinity)
      }
      .padding(.horizontal, LookIslandMetrics.expandedSideInset + 8)
      .padding(.top, 8)
      .padding(.bottom, 12)
    case .plan(let requestId, let sessionId, let title):
      VStack(alignment: .leading, spacing: 8) {
        Text(title.isEmpty ? state.strings.planReviewTitle : title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundColor(.white)
          .lineLimit(2)
        HStack(spacing: 6) {
          LookIslandActionButton(title: state.strings.approve, style: .primary) {
            onPlanAction(requestId, sessionId, "approve")
          }
          LookIslandActionButton(title: state.strings.reject, style: .danger) {
            onPlanAction(requestId, sessionId, "reject")
          }
        }
        .frame(maxWidth: .infinity)
      }
      .padding(.horizontal, LookIslandMetrics.expandedSideInset + 8)
      .padding(.top, 8)
      .padding(.bottom, 12)
    case nil:
      EmptyView()
    }
  }

  private var headerTitle: String {
    switch state.interaction {
    case .permission: return state.strings.permissionPromptTitle
    case .plan: return state.strings.planReviewTitle
    case nil: return ""
    }
  }
}

private enum LookIslandActionButtonStyle {
  case primary
  case secondary
  case danger
}

private struct LookIslandActionButton: View {
  let title: String
  let style: LookIslandActionButtonStyle
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 11, weight: .semibold))
        .foregroundColor(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(
          RoundedRectangle(cornerRadius: 8)
            .fill(background)
        )
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private var background: Color {
    switch style {
    case .primary: return lookIslandOrange
    case .secondary: return Color.white.opacity(0.14)
    case .danger: return Color.white.opacity(0.1)
    }
  }
}

// MARK: - Root view

struct LookIslandRootView: View {
  @ObservedObject var model: LookIslandModel
  let onExpand: () -> Void
  let onFocusSession: (String) -> Void
  let onPermissionAction: (String, String) -> Void
  let onPlanAction: (String, String, String) -> Void

  var body: some View {
    GeometryReader { proxy in
      let layout = LookIslandLayout.compute(
        state: model.state,
        availableFrameWidth: proxy.size.width,
        screenMetrics: model.screenMetrics,
        preferredContentWidth: model.preferredContentWidth
      )
      ZStack(alignment: .top) {
        if model.state.visible {
          if model.state.mode == "expanded" {
            if model.state.interaction != nil {
              LookIslandBlockingCardView(
                state: model.state,
                width: layout.contentWidth,
                height: layout.contentHeight,
                topExtension: layout.topExtension,
                bottomRadius: layout.bottomRadius,
                onPermissionAction: onPermissionAction,
                onPlanAction: onPlanAction
              )
              .position(x: proxy.size.width / 2, y: layout.contentHeight / 2)
              .animation(
                .spring(response: 0.42, dampingFraction: 0.82),
                value: layout
              )
            } else {
              LookIslandExpandedCardView(
                state: model.state,
                width: layout.contentWidth,
                height: layout.contentHeight,
                topExtension: layout.topExtension,
                bottomRadius: layout.bottomRadius,
                hasHardwareNotch: layout.hasHardwareNotch,
                notchWidth: layout.notchWidth,
                onFocusSession: onFocusSession
              )
              .position(x: proxy.size.width / 2, y: layout.contentHeight / 2)
              .animation(
                .spring(response: 0.42, dampingFraction: 0.82),
                value: layout
              )
            }
          } else {
            LookIslandPillView(
              state: model.state,
              height: layout.contentHeight,
              hasHardwareNotch: layout.hasHardwareNotch,
              notchWidth: layout.notchWidth,
              onContentWidth: { measured in
                if abs(measured - model.pillContentWidth) > 1 {
                  model.pillContentWidth = measured
                  model.onPillContentWidthMeasured?(measured)
                }
              }
            )
            .position(x: proxy.size.width / 2, y: layout.contentHeight / 2)
            .animation(
              .spring(response: 0.42, dampingFraction: 0.82),
              value: layout
            )
            .onTapGesture { onExpand() }
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .opacity(model.state.visible ? 1 : 0)
    }
  }
}

// MARK: - Layout

private struct LookIslandLayout: Equatable {
  let contentWidth: CGFloat
  let contentHeight: CGFloat
  let carrierWidth: CGFloat
  let carrierHeight: CGFloat
  let topExtension: CGFloat
  let bottomRadius: CGFloat
  let hasHardwareNotch: Bool
  let notchWidth: CGFloat

  static func compute(
    state: LookIslandDisplayState,
    availableFrameWidth: CGFloat,
    screenMetrics: LookIslandScreenMetrics,
    preferredContentWidth: CGFloat? = nil
  ) -> LookIslandLayout {
    let hasSession = state.pillSnapshot.sessionCount > 0
    let expanded = state.mode == "expanded"
    let notchWidth = CGFloat(screenMetrics.notchWidth)

    let contentWidth: CGFloat
    let contentHeight: CGFloat
    let topExtension: CGFloat
    let bottomRadius: CGFloat

    if expanded {
      contentWidth = min(
        availableFrameWidth,
        (preferredContentWidth ?? (hasSession ? LookIslandMetrics.expandedMaxWidth : LookIslandMetrics.expandedMinWidth))
      )
      if state.interaction != nil {
        contentHeight = LookIslandMetrics.expandedTopBarHeight + 92
      } else {
        let rows = min(state.sessions.count, LookIslandMetrics.expandedMaxVisibleRows)
        let estimatedHeight = LookIslandMetrics.expandedTopBarHeight
          + CGFloat(rows) * LookIslandMetrics.expandedRowHeight
          + LookIslandMetrics.expandedVerticalPadding
        contentHeight = max(
          LookIslandMetrics.expandedMinHeight,
          min(LookIslandMetrics.expandedMaxHeight, estimatedHeight)
        )
      }
      topExtension = 14
      bottomRadius = 18
    } else {
      if screenMetrics.hasNotch {
        let extra = max(LookIslandMetrics.hardwareExtraWidth, 0)
        contentWidth = min(
          availableFrameWidth,
          preferredContentWidth ?? max(LookIslandMetrics.compactIdleWidth, notchWidth + extra)
        )
      } else {
        let extra = hasSession ? LookIslandMetrics.compactSimulatedActiveExtraWidth : 0
        contentWidth = min(
          availableFrameWidth,
          preferredContentWidth ?? max(LookIslandMetrics.compactIdleWidth, notchWidth + extra)
        )
      }
      contentHeight = LookIslandMetrics.closedHeight
      topExtension = 0
      bottomRadius = contentHeight / 2
    }

    let carrierWidth = contentWidth + LookIslandMetrics.carrierInset * 2
    let carrierHeight = contentHeight + LookIslandMetrics.shadowBottomMargin

    return LookIslandLayout(
      contentWidth: min(contentWidth, max(1, availableFrameWidth)),
      contentHeight: contentHeight,
      carrierWidth: min(carrierWidth, max(1, availableFrameWidth)),
      carrierHeight: carrierHeight,
      topExtension: topExtension,
      bottomRadius: bottomRadius,
      hasHardwareNotch: screenMetrics.hasNotch,
      notchWidth: CGFloat(screenMetrics.notchWidth)
    )
  }
}

// MARK: - Panel

final class LookIslandPanel: NSPanel {
  // Ambient UI: never steal key/main status from the user's active app.
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

private final class LookIslandContentRootView: NSView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private final class LookIslandHostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - Controller

final class LookIslandController {
  private let model = LookIslandModel()
  private let panel: LookIslandPanel
  private let onExpand: () -> Void
  private let onFocusSession: (String) -> Void
  private let onOutsideClick: () -> Void
  private let onPermissionAction: (String, String) -> Void
  private let onPlanAction: (String, String, String) -> Void

  private var lastCocoaFrame: NSRect?
  private var globalClickMonitor: Any?
  private var localClickMonitor: Any?
  private var lastState = LookIslandDisplayState.empty

  init(
    onExpand: @escaping () -> Void,
    onFocusSession: @escaping (String) -> Void,
    onOutsideClick: @escaping () -> Void,
    onPermissionAction: @escaping (String, String) -> Void,
    onPlanAction: @escaping (String, String, String) -> Void
  ) {
    self.onExpand = onExpand
    self.onFocusSession = onFocusSession
    self.onOutsideClick = onOutsideClick
    self.onPermissionAction = onPermissionAction
    self.onPlanAction = onPlanAction
    panel = LookIslandPanel(
      contentRect: NSRect(x: 0, y: 0, width: 400, height: 54),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 2)
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = false
    panel.acceptsMouseMovedEvents = true

    let contentRoot = LookIslandContentRootView(frame: NSRect(x: 0, y: 0, width: 400, height: 54))
    let hostingView = LookIslandHostingView(
      rootView: LookIslandRootView(
        model: model,
        onExpand: onExpand,
        onFocusSession: onFocusSession,
        onPermissionAction: onPermissionAction,
        onPlanAction: onPlanAction
      )
    )
    hostingView.frame = contentRoot.bounds
    hostingView.autoresizingMask = [.width, .height]
    contentRoot.addSubview(hostingView)
    panel.contentView = contentRoot

    installEventMonitors()
    model.onPillContentWidthMeasured = { [weak self] measured in
      self?.resizeToFitPillContentWidth(measured)
    }
  }

  deinit { close() }

  func close() {
    removeEventMonitors()
    model.state = .empty
    panel.orderOut(nil)
  }

  func apply(state: LookIslandDisplayState, frame: LookIslandNativeFrame) {
    let screen = screenForDisplayId(frame.displayId) ?? LookIslandScreenMetricsProvider.preferredScreen()
    let screenMetrics = LookIslandScreenMetricsProvider.metrics(for: screen)
    model.screenMetrics = screenMetrics
    model.preferredContentWidth = frame.contentWidth.map { CGFloat($0) }

    let cocoaFrame = cocoaFrameFor(
      state: state,
      frame: frame,
      screenMetrics: screenMetrics,
      screen: screen
    )

    if lastCocoaFrame != cocoaFrame {
      setPanelFrame(cocoaFrame, animated: lastCocoaFrame != nil)
      lastCocoaFrame = cocoaFrame
    }
    withAnimation(.spring(response: 0.42, dampingFraction: 0.82)) {
      model.state = state
    }
    lastState = state
    if state.visible {
      panel.orderFrontRegardless()
    } else {
      panel.orderOut(nil)
    }
  }

  // MARK: Click handling (expand / outside-click). No drag — clicks are
  // always reliable: compact pill expands, expanded surface passes events
  // through to SwiftUI buttons/rows, clicks outside collapse.

  private func installEventMonitors() {
    let clickMask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: clickMask) { [weak self] event in
      DispatchQueue.main.async {
        self?.handleOutsideMouseDown(event: event)
      }
    }
    localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: clickMask) { [weak self] event in
      if self?.handleLocalMouseDown(event: event) == true {
        return nil
      }
      return event
    }
  }

  private func removeEventMonitors() {
    for monitor in [globalClickMonitor, localClickMonitor] {
      if let monitor { NSEvent.removeMonitor(monitor) }
    }
    globalClickMonitor = nil
    localClickMonitor = nil
  }

  /// Returns true when the event was consumed (compact pill click → expand).
  private func handleLocalMouseDown(event: NSEvent) -> Bool {
    guard lastState.visible else { return false }
    let screenPoint = NSEvent.mouseLocation
    if panel.frame.contains(screenPoint) {
      if lastState.mode != "expanded" {
        onExpand()
        return true
      }
      // Expanded: let SwiftUI buttons / session rows handle the click.
      return false
    }
    if lastState.mode == "expanded" {
      onOutsideClick()
    }
    return false
  }

  private func handleOutsideMouseDown(event: NSEvent) {
    guard lastState.visible, lastState.mode == "expanded" else { return }
    let location = event.locationInWindow
    let screenPoint = event.window?.convertToScreen(NSRect(origin: location, size: .zero)).origin
      ?? NSEvent.mouseLocation
    guard !panel.frame.contains(screenPoint) else { return }
    onOutsideClick()
  }


  // MARK: Frame geometry

  private func setPanelFrame(_ frame: NSRect, animated: Bool) {
    if animated {
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.32
        context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        panel.animator().setFrame(frame, display: true)
      }
    } else {
      panel.setFrame(frame, display: true)
    }
  }

  private func screenForDisplayId(_ displayId: Int) -> NSScreen? {
    NSScreen.screens.first {
      LookIslandScreenMetricsProvider.displayId(for: $0) == displayId
    }
  }

  private func screenForCurrentPanel() -> NSScreen? {
    NSScreen.screens.first(where: { $0.frame.intersects(panel.frame) }) ?? panel.screen ?? NSScreen.main
  }

  /// Widen the panel to fit the measured pill content (never clipped by the
  /// hardware notch or screen edges). The pill renders at its natural width;
  /// we only grow the carrier if the measurement exceeds the default width.
  private func resizeToFitPillContentWidth(_ measured: CGFloat) {
    guard lastState.visible, lastState.mode != "expanded", measured > 0 else { return }
    guard let screen = screenForCurrentPanel() else { return }
    let metrics = LookIslandScreenMetricsProvider.metrics(for: screen)
    let availableFrameWidth = max(1, screen.frame.width - LookIslandMetrics.screenEdgeGutter * 2)
    let layout = LookIslandLayout.compute(
      state: lastState,
      availableFrameWidth: availableFrameWidth,
      screenMetrics: metrics,
      preferredContentWidth: model.preferredContentWidth
    )
    let fittedContent = max(layout.contentWidth, measured)
    let carrierWidth = min(fittedContent + LookIslandMetrics.carrierInset * 2, availableFrameWidth)
    let carrierHeight = layout.contentHeight + LookIslandMetrics.shadowBottomMargin
    let centerX = LookIslandScreenMetricsProvider.notchCenterX(for: screen) ?? screen.frame.midX
    let target = NSRect(
      x: round(centerX - carrierWidth / 2),
      y: screen.frame.maxY - carrierHeight,
      width: carrierWidth,
      height: carrierHeight
    )
    if abs(target.width - panel.frame.width) > 1 || abs(target.height - panel.frame.height) > 1 {
      setPanelFrame(target, animated: false)
      lastCocoaFrame = target
    }
  }

  private func cocoaFrameFor(
    state: LookIslandDisplayState,
    frame: LookIslandNativeFrame,
    screenMetrics: LookIslandScreenMetrics,
    screen: NSScreen?
  ) -> NSRect {
    let screenWidth = screen?.frame.width ?? 1440
    let availableFrameWidth = max(1, screenWidth - LookIslandMetrics.screenEdgeGutter * 2)
    // Reuse the single geometry source (Layout.compute) — never duplicate the
    // compact/expanded width+height formulas between content and panel frame.
    let layout = LookIslandLayout.compute(
      state: state,
      availableFrameWidth: availableFrameWidth,
      screenMetrics: screenMetrics,
      preferredContentWidth: frame.contentWidth.map { CGFloat($0) }
    )
    let contentWidth = layout.contentWidth
    let contentHeight = layout.contentHeight

    let carrierWidth = min(
      contentWidth + LookIslandMetrics.carrierInset * 2,
      availableFrameWidth
    )
    let carrierHeight = contentHeight + LookIslandMetrics.shadowBottomMargin

    let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let centerXRatio = frame.centerXRatio.map { CGFloat($0) }
    // Anchor priority: persisted user ratio > physical notch center > screen center.
    let centerX: CGFloat
    if let centerXRatio {
      centerX = clamp(screenFrame.minX + screenFrame.width * centerXRatio, screenFrame.minX + carrierWidth / 2, screenFrame.maxX - carrierWidth / 2)
    } else if let notchCenterX = LookIslandScreenMetricsProvider.notchCenterX(for: screen) {
      centerX = clamp(notchCenterX, screenFrame.minX + carrierWidth / 2, screenFrame.maxX - carrierWidth / 2)
    } else {
      centerX = screenFrame.midX
    }
    let x = round(centerX - carrierWidth / 2)
    let y = screenFrame.maxY - carrierHeight
    return NSRect(x: x, y: y, width: carrierWidth, height: carrierHeight)
  }

  private func clamp(_ value: CGFloat, _ minValue: CGFloat, _ maxValue: CGFloat) -> CGFloat {
    min(max(value, minValue), maxValue)
  }
}

// MARK: - App delegate

final class LookIslandAppDelegate: NSObject, NSApplicationDelegate {
  private let controller = LookIslandController(
    onExpand: {
      emitJson(["type": "expand"])
    },
    onFocusSession: { sessionId in
      emitJson(["type": "focus-session", "sessionId": sessionId])
    },
    onOutsideClick: {
      emitJson(["type": "outside-click"])
    },
    onPermissionAction: { requestId, action in
      emitJson(["type": "permission-action", "requestId": requestId, "action": action])
    },
    onPlanAction: { requestId, sessionId, action in
      emitJson(["type": "plan-action", "requestId": requestId, "sessionId": sessionId, "action": action])
    }
  )

  func applicationDidFinishLaunching(_ notification: Notification) {
    emitScreenMetrics()
    emitJson(["type": "ready", "protocol": 1])
    startReadingStdin()
  }

  private func startReadingStdin() {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      while let line = readLine() {
        self?.handleLine(line)
      }
      DispatchQueue.main.async {
        NSApp.terminate(nil)
      }
    }
  }

  private func handleLine(_ line: String) {
    guard let data = line.data(using: .utf8) else { return }
    do {
      let message = try JSONDecoder().decode(RawIncomingMessage.self, from: data)
      switch message.type {
      case "update":
        guard let state = message.state, let frame = message.frame else { return }
        if let protocolVersion = message.protocolVersion, protocolVersion != 1 {
          emitJson(["type": "error", "message": "Unsupported look island protocol version: \(protocolVersion)"])
          return
        }
        DispatchQueue.main.async { [controller] in
          controller.apply(state: state, frame: frame)
        }
      case "shutdown":
        DispatchQueue.main.async { [controller] in
          controller.close()
          NSApp.terminate(nil)
        }
      default:
        break
      }
    } catch {
      emitJson(["type": "error", "message": "Could not decode look island update: \(error)"])
    }
  }
}

// MARK: - Main

let app = NSApplication.shared
let delegate = LookIslandAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
