import SwiftUI

/// The `fm-btn` button: primary for the main action, ghost for the rest.
struct FMButtonStyle: ButtonStyle {
    enum Variant { case primary, ghost }
    enum Size { case regular, small }

    var variant: Variant
    var size: Size = .regular

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(size == .small ? .footnote.weight(.semibold) : .subheadline.weight(.semibold))
            .foregroundStyle(variant == .primary ? Color.onAccent : Color.fg2)
            .padding(.horizontal, size == .small ? 12 : 16)
            // The web's 40px, raised to iOS's 44pt touch target.
            .frame(minHeight: size == .small ? 36 : 44)
            .background(background(pressed: configuration.isPressed), in: .rect(cornerRadius: 8))
            .contentShape(.rect(cornerRadius: 8))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }

    private func background(pressed: Bool) -> Color {
        switch variant {
        case .primary: pressed ? .accentPress : .accent
        case .ghost: pressed ? .bgHover : .clear
        }
    }
}

extension ButtonStyle where Self == FMButtonStyle {
    static var primary: FMButtonStyle { FMButtonStyle(variant: .primary) }
    static var ghost: FMButtonStyle { FMButtonStyle(variant: .ghost) }
    static func primary(_ size: FMButtonStyle.Size) -> FMButtonStyle { FMButtonStyle(variant: .primary, size: size) }
    static func ghost(_ size: FMButtonStyle.Size) -> FMButtonStyle { FMButtonStyle(variant: .ghost, size: size) }
}

/// The wordmark of the app's frame: the ball and the name.
struct Wordmark: View {
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(Color.accent).frame(width: 22, height: 22)
            Text("FortyMM")
                .font(.display(size: 28))
                .tracking(28 * 0.02)
                .foregroundStyle(Color.fg1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("FortyMM")
        .accessibilityAddTraits(.isImage)
    }
}

/// An avatar of a display name's initials. VoiceOver reads the full name.
struct PlayerAvatar: View {
    let player: Player

    var body: some View {
        Text(player.initials)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Color.fg2)
            .frame(width: 36, height: 36)
            .background(Color.bgHover, in: .circle)
            .accessibilityLabel(player.displayName)
    }
}

/// A full screen in place of the app when something fails, or after
/// sign-out: the wordmark, then what happened, why, and what to do next.
/// It uses the splash screen's frame.
struct ErrorScreen<Note: View, Actions: View>: View {
    let title: String
    let message: String
    @ViewBuilder var note: Note
    @ViewBuilder var actions: Actions

    var body: some View {
        GeometryReader { viewport in
            ScrollView {
                content
                    .frame(maxWidth: .infinity, minHeight: viewport.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Color.bgApp)
    }

    private var content: some View {
            VStack(spacing: 16) {
                Text("FortyMM")
                    .font(.display(size: 40))
                    .tracking(40 * 0.04)
                    .foregroundStyle(Color.fg1)
                    .accessibilityAddTraits(.isHeader)
                Text(title)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Color.fg1)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 16)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(Color.fg2)
                note
                VStack(spacing: 12) { actions }
                    .padding(.top, 8)
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: 420)
            .padding(24)
    }
}

extension ErrorScreen where Note == EmptyView {
    init(title: String, message: String, @ViewBuilder actions: () -> Actions) {
        self.init(title: title, message: message, note: { EmptyView() }, actions: actions)
    }
}
