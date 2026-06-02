import SwiftUI

/// Placeholder screen for the tabs that don't have a real surface yet. The top
/// bar is owned by `MainTabView`, so this is just the screen's content.
struct FMComingSoon: View {
    let title: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FMSpace.s3) {
                FMEyebrow(text: title)
                Text("Coming soon.")
                    .font(FMFont.display(40))
                    .foregroundStyle(FMColor.fg1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, FMSpace.s5)
            .padding(.vertical, FMSpace.s6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FMColor.bgApp.ignoresSafeArea())
    }
}

#Preview {
    FMComingSoon(title: "Matches")
        .preferredColorScheme(.dark)
}
