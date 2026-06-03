import SwiftUI

/// Circular avatar for the match flow. `you` players get the orange gradient;
/// everyone else gets their palette color. `glow` is the win/focus halo.
struct MatchAvatar: View {
    let player: MatchPlayer
    var size: CGFloat = 40
    var glow: Bool = false

    var body: some View {
        Text(player.initials)
            .font(FMFont.ui(size * 0.34, weight: .bold))
            .tracking(0.4)
            .foregroundStyle(player.you ? .white : Color.white.opacity(0.92))
            .frame(width: size, height: size)
            .background(background)
            .clipShape(Circle())
            .overlay {
                if glow { Circle().stroke(FMColor.ball500, lineWidth: 2) }
            }
            .shadow(color: glow ? FMColor.ball500.opacity(0.4) : .clear, radius: 12)
    }

    @ViewBuilder
    private var background: some View {
        if player.you {
            LinearGradient(
                colors: [Color(hex: 0xFF8A2E), FMColor.ball700],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        } else {
            player.avatarColor.color
        }
    }
}
