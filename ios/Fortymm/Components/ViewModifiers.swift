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

    /// Run `action` whenever the app returns to the foreground. `.onChange`
    /// doesn't fire for the initial `.active` value, so this only triggers on a
    /// real background/inactive → active transition — used by the dashboard,
    /// matches list, and match detail to pick up cross-device changes.
    func refetchOnForeground(_ action: @escaping () -> Void) -> some View {
        modifier(RefetchOnForeground(action: action))
    }

    /// Run `action` when this view's tab becomes the selected tab — the tab-return
    /// sibling of `.refetchOnForeground`. `isSelected` is derived by `MainTabView`
    /// from the `TabView` selection it owns (so the tab identity lives in one
    /// place, next to the `.tag`). `.onChange` skips the initial value, so this
    /// fires only on the transition *into* selected — a real tab-return — not on
    /// first appearance, which rides `.task`. Deterministic where `.onAppear` on
    /// `TabView` tab-return is not (ADR 0010).
    func refetchWhenSelected(_ isSelected: Bool, _ action: @escaping () -> Void) -> some View {
        modifier(RefetchWhenSelected(isSelected: isSelected, action: action))
    }

    /// Present the resume-scoring flow over this view, driven by `item`. On
    /// dismissal it clears `item` and runs `onFinish` (the surface's refetch),
    /// so a resumed/posted match is reflected instead of the stale pre-resume
    /// copy. Centralizes the three identical resume covers.
    func resumeScoringCover(
        _ item: Binding<ResumeScoring?>,
        onFinish: @escaping () -> Void
    ) -> some View {
        fullScreenCover(item: item) { ctx in
            MatchFlowView(resume: ctx) { _ in
                item.wrappedValue = nil
                onFinish()
            }
        }
    }
}

private struct RefetchOnForeground: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    let action: () -> Void

    func body(content: Content) -> some View {
        content.onChange(of: scenePhase) { _, phase in
            if phase == .active { action() }
        }
    }
}

private struct RefetchWhenSelected: ViewModifier {
    let isSelected: Bool
    let action: () -> Void

    func body(content: Content) -> some View {
        content.onChange(of: isSelected) { _, selected in
            if selected { action() }
        }
    }
}
