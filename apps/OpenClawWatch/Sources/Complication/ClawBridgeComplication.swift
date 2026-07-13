import SwiftUI
import WidgetKit

struct ClawBridgeComplicationEntry: TimelineEntry {
    let date: Date
}

struct ClawBridgeComplicationProvider: TimelineProvider {
    func placeholder(in context: Context) -> ClawBridgeComplicationEntry {
        ClawBridgeComplicationEntry(date: Date())
    }

    func getSnapshot(
        in context: Context,
        completion: @escaping (ClawBridgeComplicationEntry) -> Void
    ) {
        completion(ClawBridgeComplicationEntry(date: Date()))
    }

    func getTimeline(
        in context: Context,
        completion: @escaping (Timeline<ClawBridgeComplicationEntry>) -> Void
    ) {
        let entry = ClawBridgeComplicationEntry(date: Date())
        completion(Timeline(entries: [entry], policy: .never))
    }
}

struct ClawBridgeComplicationEntryView: View {
    @Environment(\.widgetFamily) private var family

    var entry: ClawBridgeComplicationProvider.Entry

    var body: some View {
        content
            .containerBackground(for: .widget) {
                Color.clear
            }
            .widgetURL(URL(string: "clawbridge://record"))
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryInline:
            Label(complicationDisplayName, image: "ComplicationIcon")
        case .accessoryRectangular:
            HStack(spacing: 6) {
                complicationIcon
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(complicationDisplayName)
                        .font(.headline)
                    Text("Record")
                        .font(.caption2)
                }
            }
        case .accessoryCorner:
            complicationIcon
                .widgetLabel {
                    Text("Record")
                }
        default:
            ZStack {
                AccessoryWidgetBackground()
                complicationIcon
                    .padding(4)
            }
        }
    }

    private var complicationIcon: some View {
        Image("ComplicationIcon")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .accessibilityLabel(complicationDisplayName)
    }

    private var complicationDisplayName: String {
        configuredComplicationDisplayName
    }
}

struct ClawBridgeRecordComplication: Widget {
    let kind = "ClawBridgeRecordComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ClawBridgeComplicationProvider()) { entry in
            ClawBridgeComplicationEntryView(entry: entry)
        }
        .configurationDisplayName("Record Message")
        .description("Open \(configuredComplicationDisplayName) ready to record a voice message.")
        .supportedFamilies([
            .accessoryCircular,
            .accessoryCorner,
            .accessoryInline,
            .accessoryRectangular
        ])
    }
}

private var configuredComplicationDisplayName: String {
    let configured = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return configured.flatMap { $0.isEmpty ? nil : $0 } ?? "Claw Bridge"
}

@main
struct ClawBridgeComplicationBundle: WidgetBundle {
    var body: some Widget {
        ClawBridgeRecordComplication()
    }
}
