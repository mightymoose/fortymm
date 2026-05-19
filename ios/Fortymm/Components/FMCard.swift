import SwiftUI

struct FMCard<Content: View>: View {
    var featured: Bool = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(FMSpace.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(FMColor.bgCard)
            .fmRoundedBorder(
                radius: FMRadius.lg,
                color: featured ? FMColor.borderAccent : FMColor.borderSubtle,
                lineWidth: featured ? 1.5 : 1
            )
            .shadow(color: featured ? FMColor.ball500.opacity(0.25) : .clear, radius: 16, x: 0, y: 8)
    }
}

struct FMSection<Content: View>: View {
    let title: String
    var trailing: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: FMSpace.s4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Spacer()
                if let trailing {
                    Text(trailing.uppercased())
                        .font(FMFont.mono(FMFont.xs))
                        .tracking(1.2)
                        .foregroundStyle(FMColor.fgMuted)
                }
            }
            content()
        }
        .padding(FMSpace.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.bgPanel)
        .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
    }
}
