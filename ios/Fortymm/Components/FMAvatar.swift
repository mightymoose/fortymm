import SwiftUI

struct FMAvatar: View {
    let initials: String
    var size: CGFloat = 32
    var color: Color = FMColor.ink600
    var foreground: Color = FMColor.fg2

    var body: some View {
        Text(initials)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(foreground)
            .frame(width: size, height: size)
            .background(color)
            .clipShape(Circle())
    }
}

struct FMAvatarStack: View {
    let avatars: [FMAvatar]
    var extra: Int = 0
    var size: CGFloat = 32
    var ringColor: Color = FMColor.bgPanel

    var body: some View {
        HStack(spacing: -size * 0.3) {
            ForEach(0..<avatars.count, id: \.self) { i in
                avatars[i]
                    .overlay(Circle().stroke(ringColor, lineWidth: 2))
            }
            if extra > 0 {
                FMAvatar(initials: "+\(extra)", size: size, color: FMColor.ink600)
                    .overlay(Circle().stroke(ringColor, lineWidth: 2))
            }
        }
    }
}
