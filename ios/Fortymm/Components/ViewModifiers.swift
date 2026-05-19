import SwiftUI

extension View {
    func fmRoundedBorder(radius: CGFloat, color: Color, lineWidth: CGFloat = 1) -> some View {
        self
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(color, lineWidth: lineWidth)
            )
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}
