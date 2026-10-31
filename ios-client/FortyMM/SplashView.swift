import SwiftUI

/// The wordmark on the app background, as the web client's loading screen
/// shows it. Nothing moves, because the design system's motion is feedback
/// only.
struct SplashView: View {
    var body: some View {
        Text("FortyMM")
            .font(.display(size: 40))
            // The web's letter-spacing of 0.04em.
            .tracking(40 * 0.04)
            .foregroundStyle(Color.fg1)
            .accessibilityAddTraits(.isHeader)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.bgApp)
    }
}

#Preview {
    SplashView()
}
