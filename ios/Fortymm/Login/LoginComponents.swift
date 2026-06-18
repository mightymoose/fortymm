import SwiftUI

// Native reimplementation of the FortyMM "Login flow" design (Claude Design
// handoff). The web mock is a split shell (hero left, stepped form right); on
// mobile it reflows to a single column — hero on top, form panel below — which
// is what these components render. Colours/spacing/type come straight from the
// shared design tokens (`FMColor` / `FMFont` / `FMRadius`).

// MARK: - Hero

/// The leading `● TEXT` overline, tinted per screen (accent / live / loss).
struct LoginEyebrow: View {
    let text: String
    var color: Color = FMColor.ball500

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text.uppercased())
                .font(FMFont.ui(11, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(color)
        }
    }
}

/// The two-line Bebas display headline; the second line carries the accent.
struct LoginDisplay: View {
    let line1: String
    let line2: String
    var accent: Color = FMColor.ball500

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(line1.uppercased())
                .foregroundStyle(FMColor.fg1)
            Text(line2.uppercased())
                .foregroundStyle(accent)
        }
        .font(FMFont.display(54))
        .tracking(0.5)
        .lineSpacing(-6)
    }
}

/// The mobile hero block: wordmark, eyebrow, headline. (The desktop mock's
/// "math is quiet" solver line + footer are dropped at phone width by design.)
struct LoginHero: View {
    let eyebrow: String
    var eyebrowColor: Color = FMColor.ball500
    let line1: String
    let line2: String
    var accent: Color = FMColor.ball500

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            FMLogo(size: 26)
            LoginEyebrow(text: eyebrow, color: eyebrowColor)
            LoginDisplay(line1: line1, line2: line2, accent: accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Form panel scaffold

/// One login screen: hero on top, then the stepped form panel (numbered chip +
/// label + progress dots, title, subtitle, then the screen's own content).
struct LoginScaffold<Content: View>: View {
    let eyebrow: String
    var eyebrowColor: Color = FMColor.ball500
    let line1: String
    let line2: String
    var accent: Color = FMColor.ball500
    let stepNo: String
    let stepLabel: String
    let title: String
    let subtitle: String
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                LoginHero(
                    eyebrow: eyebrow, eyebrowColor: eyebrowColor,
                    line1: line1, line2: line2, accent: accent
                )
                VStack(alignment: .leading, spacing: 16) {
                    LoginStepHeader(stepNo: stepNo, stepLabel: stepLabel, accent: accent)
                    Text(title)
                        .font(FMFont.ui(24, weight: .semibold))
                        .foregroundStyle(FMColor.fg1)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(subtitle)
                        .font(FMFont.ui(14.5))
                        .foregroundStyle(FMColor.fg3)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                    content
                }
            }
            .padding(.horizontal, 22)
            .padding(.top, 18)
            .padding(.bottom, 32)
        }
        .background(LoginBackground())
    }
}

/// The numbered step chip + label + hairline + progress dots.
struct LoginStepHeader: View {
    let stepNo: String
    let stepLabel: String
    var accent: Color = FMColor.ball500

    var body: some View {
        HStack(spacing: 12) {
            Text(stepNo)
                .font(FMFont.mono(11, weight: .bold))
                .tracking(1.6)
                .foregroundStyle(accent)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(FMColor.bgAccentSoft)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(FMColor.borderSubtle, lineWidth: 1))
            Text(stepLabel.uppercased())
                .font(FMFont.ui(11, weight: .semibold))
                .tracking(1.6)
                .foregroundStyle(FMColor.fg3)
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1)
            StepDots(active: stepNo == "!!" ? -1 : (Int(stepNo) ?? 1))
        }
    }
}

/// Four progress pills; the active one widens. `active == -1` is the error
/// state (last pill turns loss-red, the rest go inert).
struct StepDots: View {
    let active: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(1...4, id: \.self) { n in
                Capsule()
                    .fill(color(for: n))
                    .frame(width: n == active ? 18 : 6, height: 6)
            }
        }
        .animation(.easeOut(duration: 0.2), value: active)
    }

    private func color(for n: Int) -> Color {
        if active == -1 {
            return n == 4 ? FMColor.loss : FMColor.ink500
        }
        return n <= active ? FMColor.ball500 : FMColor.borderSubtle
    }
}

/// Dot-grid texture + warm halo behind a login screen.
struct LoginBackground: View {
    var body: some View {
        FMColor.bgApp
            .overlay(alignment: .topLeading) {
                RadialGradient(
                    colors: [FMColor.ball500.opacity(0.18), .clear],
                    center: .topLeading, startRadius: 0, endRadius: 320
                )
                .frame(width: 460, height: 460)
                .offset(x: -90, y: -70)
                .allowsHitTesting(false)
            }
            .ignoresSafeArea()
    }
}

// MARK: - Receipt cards

/// The bordered "receipt" card used for the inbox / verify / success / error
/// detail blocks. `tint` drives the border + glow (accent / live / loss).
struct ReceiptCard<Content: View>: View {
    var tint: Color = FMColor.borderSubtle
    var glow: Bool = false
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.bgCard)
        .fmRoundedBorder(radius: FMRadius.md, color: tint)
        .shadow(color: glow ? tint.opacity(0.22) : .clear, radius: 18, y: 6)
    }
}

/// A receipt header: leading badge (spinner / check / x), a mono eyebrow, and a
/// one-line title.
struct ReceiptHeader<Badge: View>: View {
    @ViewBuilder var badge: Badge
    let eyebrow: String
    var eyebrowColor: Color
    let title: String

    var body: some View {
        HStack(spacing: 14) {
            badge
            VStack(alignment: .leading, spacing: 4) {
                Text(eyebrow)
                    .font(FMFont.mono(10.5, weight: .bold))
                    .tracking(2.0)
                    .foregroundStyle(eyebrowColor)
                Text(title)
                    .font(FMFont.ui(14, weight: .medium))
                    .foregroundStyle(FMColor.fg1)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.bottom, 12)
    }
}

/// A key/value receipt row (uppercase label + mono value).
struct ReceiptRow: View {
    let key: String
    let value: String
    var valueColor: Color = FMColor.fg1

    var body: some View {
        HStack(spacing: 14) {
            Text(key.uppercased())
                .font(FMFont.ui(11, weight: .semibold))
                .tracking(1.4)
                .foregroundStyle(FMColor.fg3)
                .frame(width: 78, alignment: .leading)
            Text(value)
                .font(FMFont.mono(13))
                .foregroundStyle(valueColor)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
    }
}

struct ReceiptDivider: View {
    var body: some View {
        Rectangle().fill(FMColor.ink700).frame(height: 1)
    }
}

// MARK: - Solver log

/// The mono request log shown while verifying (and its failed variant). Each row
/// is (status, method, path, note); `status` is colour-coded green/amber/red.
struct SolverLog: View {
    struct Line: Identifiable {
        let id = UUID()
        let status: String
        let method: String
        let path: String
        let note: String
    }

    let lines: [Line]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(lines) { line in
                HStack(spacing: 10) {
                    Text(line.status)
                        .foregroundStyle(statusColor(line.status))
                        .frame(width: 34, alignment: .leading)
                    Text(line.method)
                        .foregroundStyle(FMColor.fg2)
                        .frame(width: 42, alignment: .leading)
                    Text(line.path)
                        .foregroundStyle(statusColor(line.status) == FMColor.loss ? FMColor.loss : FMColor.ball500)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(line.note)
                        .foregroundStyle(FMColor.fgMuted)
                        .lineLimit(1)
                }
                .font(FMFont.mono(11.5))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.ink950)
        .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderSubtle)
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "200": return FMColor.serve500
        case "…", "···": return FMColor.warn
        default: return FMColor.loss
        }
    }
}

// MARK: - Badges & spinner

/// Indeterminate orange arc spinner (the verify badge).
struct LoginSpinner: View {
    var size: CGFloat = 36
    @State private var spinning = false

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.7)
            .stroke(FMColor.ball500, style: StrokeStyle(lineWidth: 3, lineCap: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(spinning ? 360 : 0))
            .animation(.linear(duration: 1).repeatForever(autoreverses: false), value: spinning)
            .onAppear { spinning = true }
    }
}

/// Circular status badge — a green check or red cross in a soft-tinted disc.
struct StatusBadge: View {
    enum Kind { case success, failure }
    let kind: Kind
    var size: CGFloat = 36

    private var tint: Color { kind == .success ? FMColor.serve500 : FMColor.loss }
    private var symbol: String { kind == .success ? "checkmark" : "xmark" }

    var body: some View {
        ZStack {
            Circle().fill(tint.opacity(0.16))
            Circle().stroke(tint, lineWidth: 1.5)
            Image(systemName: symbol)
                .font(.system(size: size * 0.42, weight: .heavy))
                .foregroundStyle(tint)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Buttons & misc

/// The top-right dismiss header shared by the modally-presented login-flow
/// landings (`LoginFlowView`, `ConfirmEmailView`) — a trailing "✕" over the
/// login background.
struct LoginCloseHeader: View {
    let onClose: () -> Void

    var body: some View {
        HStack {
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(FMColor.fg3)
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
    }
}

/// The login primary/ghost button. Primary is the ball-orange glow button with
/// an in-flight spinner; ghost is bordered. Disabled primary dims to ink.
struct LoginButton: View {
    enum Kind { case primary, ghost }

    let title: String
    var kind: Kind = .primary
    var loading: Bool = false
    var enabled: Bool = true
    var fullWidth: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if loading {
                    ProgressView().tint(kind == .primary ? FMColor.fgInverse : FMColor.fg1)
                } else {
                    Text(title).font(FMFont.ui(kind == .primary ? 15 : 14, weight: kind == .primary ? .bold : .semibold))
                }
            }
            .foregroundStyle(foreground)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .frame(height: 50)
            .padding(.horizontal, fullWidth ? 0 : 18)
            .background(background)
            .fmRoundedBorder(radius: FMRadius.md, color: borderColor)
            .shadow(color: kind == .primary && enabled ? FMColor.ball500.opacity(0.3) : .clear, radius: 12, y: 7)
        }
        .buttonStyle(.plain)
        .disabled(!enabled || loading)
    }

    private var foreground: Color {
        switch kind {
        case .primary: return enabled ? FMColor.fgInverse : FMColor.fgMuted
        case .ghost: return FMColor.fg2
        }
    }

    @ViewBuilder
    private var background: some View {
        switch kind {
        case .primary: enabled ? FMColor.ball500 : FMColor.ink800
        case .ghost: Color.clear
        }
    }

    private var borderColor: Color {
        switch kind {
        case .primary: enabled ? FMColor.ball500 : FMColor.borderSubtle
        case .ghost: FMColor.borderDefault
        }
    }
}

/// "── OR ──" divider.
struct LoginDivider: View {
    let label: String

    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1)
            Text(label)
                .font(FMFont.mono(10.5))
                .tracking(2.5)
                .foregroundStyle(FMColor.fgMuted)
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1)
        }
    }
}

/// The email field: an "@" prefix box, a mono input, and a live status chip.
/// The chip is tri-state: green "VALID" only once the address actually passes
/// validation (`valid`), red "FAILED" when flagged invalid, and a neutral dot
/// while empty / not yet evaluated — so an untouched field never claims "VALID"
/// for a blank or malformed address (#448). `invalid` flips the accent to
/// loss-red.
struct LoginEmailField: View {
    @Binding var text: String
    var valid: Bool = false
    var invalid: Bool = false
    var focused: FocusState<Bool>.Binding

    private var tint: Color { invalid ? FMColor.loss : FMColor.ball500 }

    // invalid wins over valid; neutral is the empty / not-yet-evaluated state.
    private var chipText: String {
        if invalid { return "● FAILED" }
        return valid ? "● VALID" : "●"
    }
    private var chipColor: Color {
        if invalid { return FMColor.loss }
        return valid ? FMColor.serve500 : FMColor.fgMuted
    }

    var body: some View {
        HStack(spacing: 0) {
            Text("@")
                .font(FMFont.mono(14, weight: .bold))
                .foregroundStyle(tint)
                .frame(width: 44, height: 50)
                .background(tint.opacity(0.06))
                .overlay(alignment: .trailing) {
                    Rectangle().fill(FMColor.borderSubtle).frame(width: 1)
                }
            TextField(
                "",
                text: $text,
                prompt: Text("you@yourclub.com").foregroundStyle(FMColor.fgMuted)
            )
            .font(FMFont.mono(15, weight: .medium))
            .foregroundStyle(FMColor.fg1)
            .focused(focused)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.go)
            .padding(.horizontal, 14)
            Text(chipText)
                .font(FMFont.mono(11))
                .tracking(1.4)
                .foregroundStyle(chipColor)
                .padding(.trailing, 14)
        }
        .background(FMColor.bgCard)
        .fmRoundedBorder(radius: FMRadius.md, color: invalid ? FMColor.loss : FMColor.borderDefault)
    }
}

/// Fineprint paragraph helper — small tertiary copy under the actions.
struct LoginFineprint<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .font(FMFont.ui(12.5))
            .foregroundStyle(FMColor.fg3)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
    }
}
