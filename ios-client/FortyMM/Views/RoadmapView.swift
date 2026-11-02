import SwiftUI

/// What we're building and what comes after, as the web's Home shows it.
struct RoadmapView: View {
    enum Stage {
        case ready, building, next, later

        var label: String {
            switch self {
            case .ready: "Ready"
            case .building: "Building now"
            case .next: "Next"
            case .later: "Later"
            }
        }
    }

    struct Part {
        let title: String
        let body: String
        let symbol: String
        let stage: Stage
    }

    /// The parts of FortyMM, in the order they ship.
    static let parts: [Part] = [
        Part(
            title: "Your account",
            body: "Sign in on any device. Your matches, leagues and rating stay with your account.",
            symbol: "person",
            stage: .ready
        ),
        Part(
            title: "Leagues",
            body: "Play a season with your club or your friends, and follow the standings.",
            symbol: "list.bullet",
            stage: .ready
        ),
        Part(
            title: "Matches",
            body: "Log the matches you play and follow your rating after each one.",
            symbol: "figure.table.tennis",
            stage: .building
        ),
        Part(
            title: "Basic tournaments",
            body: "Run a simple tournament with your friends, from the draw to the final.",
            symbol: "calendar",
            stage: .later
        ),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            VStack(alignment: .leading, spacing: 20) {
                Text("What’s coming, and when.")
                    .font(.largeTitle.bold())
                    .foregroundStyle(Color.fg1)
                    .accessibilityAddTraits(.isHeader)
                Text("We’re building FortyMM one part at a time. Here’s what we’re working on now and what comes after.")
                    .font(.body)
                    .foregroundStyle(Color.fg2)
                Text("FortyMM is free, and we don’t show ads.")
                    .font(.footnote)
                    .foregroundStyle(Color.fg3)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(Self.parts.enumerated()), id: \.offset) { index, part in
                    PartRow(part: part, isLast: index == Self.parts.count - 1)
                }
            }
        }
    }
}

/// One part, hanging off a rail of markers. The part being built is blue,
/// a part that is ready is green, and parts further out step down to grey.
private struct PartRow: View {
    let part: RoadmapView.Part
    let isLast: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(spacing: 4) {
                marker
                if !isLast {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Color.borderSubtle)
                        .frame(width: 2)
                        .frame(maxHeight: .infinity)
                        .padding(.bottom, 4)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        title
                        Spacer(minLength: 0)
                        status
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        title
                        status
                    }
                }
                Text(part.body)
                    .font(.subheadline)
                    .foregroundStyle(part.stage == .later ? Color.fg3 : Color.fg2)
            }
            .padding(.top, 8)
            .padding(.bottom, isLast ? 0 : 32)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    private var marker: some View {
        Image(systemName: part.symbol)
            .font(.system(size: 17))
            .foregroundStyle(markerColor)
            .frame(width: 40, height: 40)
            .background(part.stage == .building ? Color.restSoft : Color.bgPanel, in: .circle)
            .overlay { Circle().strokeBorder(markerBorder) }
            .accessibilityHidden(true)
    }

    private var title: some View {
        Text(part.title)
            .font(.title3.weight(.semibold))
            .foregroundStyle(part.stage == .later ? Color.fg2 : Color.fg1)
            .accessibilityAddTraits(.isHeader)
    }

    private var status: some View {
        Label(part.stage.label, systemImage: part.stage == .ready ? "checkmark" : "clock")
            .labelStyle(StatusLabelStyle())
            .font(.footnote.weight(.semibold))
            .foregroundStyle(statusColor)
            .lineLimit(1)
    }

    private var markerColor: Color {
        switch part.stage {
        case .building: .rest
        case .ready: .success
        case .next: .fg2
        case .later: .fg3
        }
    }

    private var markerBorder: Color {
        switch part.stage {
        case .building: .rest
        case .ready: .success
        case .next: .borderField
        case .later: .borderControl
        }
    }

    private var statusColor: Color {
        switch part.stage {
        case .building: .rest
        case .ready: .success
        case .next: .fg2
        case .later: .fg3
        }
    }
}

/// The `fm-status` marker: a small icon close to its label.
private struct StatusLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}
