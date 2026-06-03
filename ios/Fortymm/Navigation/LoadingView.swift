import SwiftUI

/// Shown while the app resolves the session on launch, before any real surface
/// is rendered. `RootView` swaps it out for the dashboard once `GET /v1/session`
/// resolves.
struct LoadingView: View {
    var body: some View {
        VStack(spacing: FMSpace.s5) {
            FMLogo(size: 30)
            ProgressView()
                .tint(FMColor.ball500)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FMColor.bgApp.ignoresSafeArea())
    }
}

#Preview {
    LoadingView()
        .preferredColorScheme(.dark)
}
