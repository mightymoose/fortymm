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

    /// Hold the realtime hint stream open for exactly as long as this surface is
    /// *in front*, and run `action` every time a hint arrives — the live sibling
    /// of the two "something changed while you were away" modifiers above.
    ///
    /// **"In front" is both halves of that pair at once:** the app is
    /// foregrounded *and* this view's tab is the selected one. Both signals
    /// already exist and are reused rather than re-derived — `isSelected` comes
    /// from `MainTabView`'s `TabView` selection for the same reason
    /// `.refetchWhenSelected` takes it (ADR 0010: `.onAppear` fires unreliably
    /// on tab-return).
    ///
    /// Neither half alone is enough. iOS suspends network connections in the
    /// background, so a stream left open there is battery cost that buys
    /// nothing; and a stream held behind another tab refreshes a screen nobody
    /// is looking at. Tearing it down costs no freshness either, because
    /// `.refetchOnForeground` and `.refetchWhenSelected` already reload this
    /// surface on the way back in — the reconnect gap is covered by a mechanism
    /// that was here first.
    ///
    /// **"Foregrounded" here is `!= .background`, not `== .active`** — the one
    /// place this deliberately reads `scenePhase` differently from
    /// `.refetchOnForeground` above, because the two ask different questions.
    /// That modifier asks "did we just come *back*?", which only a settled
    /// `.active` answers. This one asks "should a socket be held open?", and
    /// `.inactive` — the app switcher, Control Center, a system permission alert
    /// on top of the app — is still on screen and still un-suspended. Dropping
    /// the connection every time a permission alert appears would churn a
    /// reconnect for nothing. Nothing is missed on the way back either: an
    /// `.inactive` → `.active` transition fires `.refetchOnForeground` regardless.
    ///
    /// The connection is a `.task(id:)`, so SwiftUI cancels it on every way out
    /// — tab away, background, or the view leaving the hierarchy — and
    /// cancellation is precisely how `RealtimeConnection.run` stops.
    ///
    /// **Every hint that reaches `action` means "refetch", `.unknown` included.**
    /// The stream carries no payload, only "your dashboard moved"; a kind from a
    /// newer server is *delivered* rather than dropped (only an unreadable frame
    /// is dropped, inside the connection), so the coarse response is the correct
    /// one.
    ///
    /// **The one hint deliberately swallowed is the connect-time `resync`.** The
    /// server opens every stream with one, and here it is redundant by
    /// construction: becoming visible is what opened this connection, and
    /// becoming visible has already refetched. Honouring it would make every tab
    /// return cost two full fetches instead of one. Only the *first* event of a
    /// run is treated this way, and only if it is a `resync` — the later
    /// `resync`s, from the server's ~15-minute hang-up or a pub/sub recovery,
    /// are the mechanism by which a gap self-heals and must still refetch.
    func refetchOnRealtimeHint(
        whileSelected isSelected: Bool, _ action: @escaping () -> Void
    ) -> some View {
        modifier(RefetchOnRealtimeHint(isSelected: isSelected, action: action))
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

private struct RefetchOnRealtimeHint: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    let isSelected: Bool
    let action: () -> Void

    /// Both halves of "in front" — see the modifier's doc comment for why the
    /// foreground half is `!= .background` rather than `== .active`.
    private var isInFront: Bool { isSelected && scenePhase != .background }

    func body(content: Content) -> some View {
        // `.task(id:)` is the whole lifecycle: it starts on appearance, and on
        // every change of `isInFront` it cancels the running task before
        // starting the next. So the connection opens when this surface comes to
        // the front and is *cancelled* — not merely ignored — when it leaves.
        content.task(id: isInFront) {
            guard isInFront else { return }
            // Per run, not per view: each run begins with a fresh connect, and
            // it is that connect's `resync` this suppresses.
            var awaitingConnectResync = true
            await RealtimeConnection().run { event in
                let isConnectResync = awaitingConnectResync && event.kind == .resync
                awaitingConnectResync = false
                if isConnectResync { return }
                action()
            }
        }
    }
}
