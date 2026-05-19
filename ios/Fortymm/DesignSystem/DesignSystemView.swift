import SwiftUI

struct DesignSystemView: View {
    var body: some View {
        ScrollView {
            DesignSystemContent()
        }
        .background(FMColor.bgApp.ignoresSafeArea())
    }
}

struct DesignSystemContent: View {
    @State private var playerTag: String = "@nguyen.t"
    @State private var email: String = "not-an-email"
    @State private var notes: String = "Played in the back hall. Andrew's forehand was on fire today — three straight games to 11."
    @State private var emailInvites = true
    @State private var publicProfile = true
    @State private var nearbyMatches = false
    @State private var format: String = "bo5"
    @State private var sliderValue: Double = 1620
    @State private var tabIndex: Int = 0

    var body: some View {
        VStack(alignment: .leading, spacing: FMSpace.s8) {
            header
            formsSection
            dataSection
            navigationSection
            feedbackSection
            footer
        }
        .padding(.horizontal, FMSpace.s5)
        .padding(.vertical, FMSpace.s8)
        .background(FMColor.bgApp)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: FMSpace.s3) {
            HStack(alignment: .firstTextBaseline, spacing: FMSpace.s4) {
                Text("SHADCN/UI · FORTYMM")
                    .font(FMFont.display(38))
                    .foregroundStyle(FMColor.fg1)
                    .tracking(2)
                Spacer(minLength: 0)
            }
            Text("47 COMPONENTS · BRANDED · iOS DEMO")
                .font(FMFont.mono(11))
                .tracking(1.5)
                .foregroundStyle(FMColor.fgMuted)
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1).padding(.top, 4)
            Text("Every shadcn/ui component, restyled in the FortyMM dark-arena palette. Native SwiftUI implementation matching the web reference at docs/designs/design-system.html.")
                .font(FMFont.ui(FMFont.sm))
                .foregroundStyle(FMColor.fg3)
        }
    }

    // MARK: - Forms

    private var formsSection: some View {
        sectionGroup(title: "FORMS & INPUT",
                     subtitle: "Buttons, inputs, selectors. Hero color (--ball-500) is reserved for the single primary action per screen.") {
            FMSection(title: "Button", trailing: "7 variants · 4 sizes") {
                VStack(alignment: .leading, spacing: FMSpace.s3) {
                    FlowLayout(spacing: 8) {
                        FMButton(title: "Log a match", variant: .primary)
                        FMButton(title: "Save draft", variant: .secondary)
                        FMButton(title: "Cancel", variant: .outline)
                        FMButton(title: "Skip", variant: .ghost)
                        FMButton(title: "Forfeit match", variant: .destructive)
                        FMButton(title: "Read manifesto", variant: .link)
                        FMButton(title: "Disabled", variant: .disabled)
                    }
                    FlowLayout(spacing: 8) {
                        FMButton(title: "Small", size: .sm)
                        FMButton(title: "Default", size: .md)
                        FMButton(title: "Large", size: .lg)
                        FMButton(title: "+", size: .icon)
                    }
                }
            }

            FMSection(title: "Input · Label · Form Field", trailing: "composite") {
                HStack(spacing: FMSpace.s3) {
                    FMTextField(label: "Player tag",
                                placeholder: "@nguyen.t",
                                helper: "Visible to opponents in match invites.",
                                text: $playerTag)
                    FMTextField(label: "Email",
                                placeholder: "you@example.com",
                                error: "Enter a valid email address.",
                                required: true,
                                text: $email)
                }
            }

            FMSection(title: "Textarea", trailing: "resizable") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Match notes")
                        .font(FMFont.ui(FMFont.sm, weight: .medium))
                        .foregroundStyle(FMColor.fg2)
                    TextEditor(text: $notes)
                        .font(FMFont.ui(FMFont.sm))
                        .foregroundStyle(FMColor.fg1)
                        .scrollContentBackground(.hidden)
                        .padding(8)
                        .frame(minHeight: 80)
                        .background(FMColor.bgCard)
                        .overlay(
                            RoundedRectangle(cornerRadius: FMRadius.md, style: .continuous)
                                .stroke(FMColor.borderSubtle, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: FMRadius.md, style: .continuous))
                }
            }

            FMSection(title: "Input OTP", trailing: "6-digit") {
                HStack(spacing: 8) {
                    ForEach(["4", "0", "M", "M"], id: \.self) { ch in
                        Text(ch)
                            .font(FMFont.mono(20, weight: .bold))
                            .foregroundStyle(FMColor.fg1)
                            .frame(width: 44, height: 52)
                            .background(FMColor.bgCard)
                            .overlay(
                                RoundedRectangle(cornerRadius: FMRadius.md, style: .continuous)
                                    .stroke(FMColor.borderDefault, lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: FMRadius.md, style: .continuous))
                    }
                    ForEach(0..<2) { _ in
                        RoundedRectangle(cornerRadius: FMRadius.md)
                            .stroke(FMColor.borderSubtle, lineWidth: 1)
                            .frame(width: 44, height: 52)
                    }
                }
            }

            FMSection(title: "Checkbox", trailing: "3 states") {
                VStack(alignment: .leading, spacing: 10) {
                    FMCheckbox(label: "I agree to the rules of fair play",
                               isChecked: .constant(true))
                    FMCheckbox(label: "Email me match invites", isChecked: $emailInvites)
                    FMCheckbox(label: "Disabled option",
                               isChecked: .constant(false),
                               disabled: true)
                }
            }

            FMSection(title: "Radio Group", trailing: "single-select") {
                VStack(alignment: .leading, spacing: 10) {
                    FMRadio(label: "Singles · best of 5", value: "bo5", selection: $format)
                    FMRadio(label: "Singles · best of 7", value: "bo7", selection: $format)
                    FMRadio(label: "Doubles · best of 5", value: "dbo5", selection: $format)
                }
            }

            FMSection(title: "Switch", trailing: "on/off") {
                VStack(spacing: 12) {
                    FMSwitch(label: "Public profile", isOn: $publicProfile)
                    FMSwitch(label: "Notify me of nearby matches", isOn: $nearbyMatches)
                }
            }

            FMSection(title: "Slider", trailing: "rating") {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Skill level").font(FMFont.ui(FMFont.sm)).foregroundStyle(FMColor.fg2)
                        Spacer()
                        Text("\(Int(sliderValue))").font(FMFont.mono(FMFont.sm)).foregroundStyle(FMColor.fgAccent)
                    }
                    Slider(value: $sliderValue, in: 1000...2400)
                        .tint(FMColor.ball500)
                }
            }
        }
    }

    // MARK: - Data Display

    private var dataSection: some View {
        sectionGroup(title: "DATA DISPLAY",
                     subtitle: "Cards, tables, badges, avatars. The product is ratings and rankings — these components are where the numbers live.") {
            FMSection(title: "Card", trailing: "container") {
                VStack(spacing: FMSpace.s3) {
                    FMCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("April Spring Open")
                                .font(FMFont.ui(FMFont.md, weight: .semibold))
                                .foregroundStyle(FMColor.fg1)
                            Text("Hosted by Brooklyn TT Club")
                                .font(FMFont.ui(FMFont.xs))
                                .foregroundStyle(FMColor.fgMuted)
                            Text("32 players, single-elimination, 4 courts. Scheduling auto-generated by SMT solver.")
                                .font(FMFont.ui(FMFont.sm))
                                .foregroundStyle(FMColor.fg3)
                            HStack(spacing: 8) {
                                FMButton(title: "Register", variant: .primary, size: .sm)
                                FMButton(title: "View draw", variant: .outline, size: .sm)
                            }
                            .padding(.top, 4)
                        }
                    }
                    FMCard(featured: true) {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 6) {
                                Image(systemName: "star.fill")
                                    .font(.system(size: 14))
                                    .foregroundStyle(FMColor.ball500)
                                Text("Featured")
                                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                                    .foregroundStyle(FMColor.fg1)
                            }
                            Text("National Championships qualifier")
                                .font(FMFont.ui(FMFont.xs))
                                .foregroundStyle(FMColor.fgMuted)
                            Text("Top 8 advance to the regional bracket. Limited to USATT members.")
                                .font(FMFont.ui(FMFont.sm))
                                .foregroundStyle(FMColor.fg3)
                            FMButton(title: "Apply", variant: .primary, size: .sm)
                                .padding(.top, 4)
                        }
                    }
                }
            }

            FMSection(title: "Badge", trailing: "5 variants") {
                FlowLayout(spacing: 8) {
                    FMBadge(text: "Seed 1", variant: .primary)
                    FMBadge(text: "Doubles", variant: .secondary)
                    FMBadge(text: "Pending", variant: .outline)
                    FMBadge(text: "Disqualified", variant: .destructive)
                    FMBadge(text: "Live · Court 3", variant: .live)
                }
            }

            FMSection(title: "Avatar", trailing: "image · initials · stack") {
                HStack(spacing: FMSpace.s4) {
                    HStack(spacing: 8) {
                        FMAvatar(initials: "TN", color: FMColor.ink600)
                        FMAvatar(initials: "DO", color: FMColor.ink600)
                        FMAvatar(initials: "MK", size: 40, color: FMColor.ball500, foreground: FMColor.fgInverse)
                    }
                    FMAvatarStack(avatars: [
                        FMAvatar(initials: "TN", color: Color(hex: 0x3F5B8C)),
                        FMAvatar(initials: "DO", color: Color(hex: 0x8C5A3F)),
                        FMAvatar(initials: "MK", color: Color(hex: 0x4A7A4A)),
                    ], extra: 12)
                    Spacer()
                }
            }

            FMSection(title: "Table · Data Table", trailing: "sortable rows") {
                playerTable
            }

            FMSection(title: "Progress", trailing: "determinate") {
                VStack(spacing: 12) {
                    FMProgress(label: "Round 1 of 5", value: 0.75, trailing: "12 / 16")
                    FMProgress(label: "Group B", value: 0.25, trailing: "25%")
                }
            }

            FMSection(title: "Skeleton", trailing: "loading state") {
                FMSkeletonRow()
            }
        }
    }

    private struct PlayerRow {
        let initials: String
        let name: String
        let club: String
        let rating: String
        let delta: String
        let deltaColor: Color
    }

    private static let demoRows: [PlayerRow] = [
        PlayerRow(initials: "TN", name: "Nguyen, Tien", club: "Brooklyn TT", rating: "1620", delta: "+18", deltaColor: FMColor.win),
        PlayerRow(initials: "DO", name: "Okafor, Daniel", club: "NYC Open Hall", rating: "1582", delta: "+12", deltaColor: FMColor.win),
        PlayerRow(initials: "MK", name: "Kowalski, Marta", club: "Brooklyn TT", rating: "1505", delta: "-4", deltaColor: FMColor.loss),
    ]

    private var playerTable: some View {
        VStack(spacing: 0) {
            HStack {
                Text("PLAYER").frame(maxWidth: .infinity, alignment: .leading)
                Text("CLUB").frame(maxWidth: .infinity, alignment: .leading)
                Text("RATING").frame(width: 60, alignment: .trailing)
                Text("Δ").frame(width: 44, alignment: .trailing)
            }
            .font(FMFont.mono(10))
            .tracking(1)
            .foregroundStyle(FMColor.fgMuted)
            .padding(.vertical, 8)
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1)
            ForEach(Array(Self.demoRows.enumerated()), id: \.offset) { offset, r in
                HStack {
                    HStack(spacing: 8) {
                        FMAvatar(initials: r.initials, size: 24, color: FMColor.ink600)
                        Text(r.name).font(FMFont.ui(FMFont.sm)).foregroundStyle(FMColor.fg1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Text(r.club).font(FMFont.ui(FMFont.sm)).foregroundStyle(FMColor.fg3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(r.rating).font(FMFont.mono(FMFont.sm)).foregroundStyle(FMColor.fg1)
                        .frame(width: 60, alignment: .trailing)
                    Text(r.delta).font(FMFont.mono(FMFont.sm, weight: .semibold)).foregroundStyle(r.deltaColor)
                        .frame(width: 44, alignment: .trailing)
                }
                .padding(.vertical, 10)
                if offset < Self.demoRows.count - 1 {
                    Rectangle().fill(FMColor.borderSubtle.opacity(0.5)).frame(height: 1)
                }
            }
        }
    }

    // MARK: - Navigation

    private var navigationSection: some View {
        sectionGroup(title: "NAVIGATION",
                     subtitle: "Tabs, breadcrumbs, pagination, menus. Wayfinding inside the app.") {
            FMSection(title: "Tabs", trailing: "underlined or boxed") {
                VStack(alignment: .leading, spacing: FMSpace.s3) {
                    FMTabs(items: ["Overview", "Schedule", "Standings", "Players"], selection: $tabIndex)
                    Text("Tournament overview — 32 players, 4 courts, finals projected for 6:45pm.")
                        .font(FMFont.ui(FMFont.sm))
                        .foregroundStyle(FMColor.fg3)
                }
            }

            FMSection(title: "Breadcrumb", trailing: "trail") {
                HStack(spacing: 6) {
                    Text("Tournaments").font(FMFont.ui(FMFont.sm)).foregroundStyle(FMColor.fgMuted)
                    Text("/").font(FMFont.ui(FMFont.sm)).foregroundStyle(FMColor.borderDefault)
                    Text("April Spring Open").font(FMFont.ui(FMFont.sm)).foregroundStyle(FMColor.fgMuted)
                    Text("/").font(FMFont.ui(FMFont.sm)).foregroundStyle(FMColor.borderDefault)
                    Text("Round 3").font(FMFont.ui(FMFont.sm, weight: .semibold)).foregroundStyle(FMColor.fg1)
                    Spacer()
                }
            }

            FMSection(title: "Pagination", trailing: "paged tables") {
                HStack(spacing: 4) {
                    pageButton("‹", selected: false)
                    pageButton("1", selected: true)
                    pageButton("2", selected: false)
                    pageButton("3", selected: false)
                    pageButton("…", selected: false)
                    pageButton("12", selected: false)
                    pageButton("›", selected: false)
                    Spacer()
                }
            }
        }
    }

    private func pageButton(_ label: String, selected: Bool) -> some View {
        Text(label)
            .font(FMFont.ui(FMFont.sm, weight: .medium))
            .foregroundStyle(selected ? FMColor.fg1 : FMColor.fg3)
            .frame(width: 32, height: 32)
            .background(selected ? FMColor.bgRaised : Color.clear)
            .overlay(
                RoundedRectangle(cornerRadius: FMRadius.sm, style: .continuous)
                    .stroke(selected ? FMColor.borderDefault : Color.clear, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FMRadius.sm, style: .continuous))
    }

    // MARK: - Feedback

    private var feedbackSection: some View {
        sectionGroup(title: "FEEDBACK",
                     subtitle: "Alerts and toasts. The app talking back.") {
            FMSection(title: "Alert", trailing: "4 variants") {
                VStack(spacing: FMSpace.s3) {
                    FMAlert(title: "Heads up",
                            message: "The next round starts in 12 minutes.",
                            variant: .info)
                    FMAlert(title: "Late check-in",
                            message: "3 players haven't checked in. They'll be defaulted at 6:00pm.",
                            variant: .warn)
                    FMAlert(title: "Match disputed",
                            message: "A player has filed a score dispute. Review the appeal in the admin panel.",
                            variant: .destructive)
                    FMAlert(title: "Match logged",
                            message: "Your rating moved from 1602 to 1620 (+18).",
                            variant: .success)
                }
            }

            FMSection(title: "Sonner / Toast", trailing: "4 variants") {
                VStack(spacing: FMSpace.s3) {
                    FMToast(title: "A new version of FortyMM is ready",
                            message: "Reload to get the latest update.",
                            variant: .info,
                            actionTitle: "Reload")
                    FMToast(title: "Match logged",
                            message: "Rating: 1620 (+18)",
                            variant: .success)
                    FMToast(title: "Couldn't save",
                            message: "Try again — your changes are still in the editor.",
                            variant: .destructive)
                    FMToast(title: "Reminder",
                            message: "You're up next on Court 3.",
                            variant: .reminder)
                }
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Text("FortyMM · shadcn/ui · v1")
                .font(FMFont.mono(FMFont.xs))
                .foregroundStyle(FMColor.fgMuted)
            Spacer()
        }
        .padding(.top, FMSpace.s8)
    }

    // MARK: - Helpers

    @ViewBuilder
    private func sectionGroup<C: View>(title: String, subtitle: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: FMSpace.s4) {
            Text(title)
                .font(FMFont.display(28))
                .foregroundStyle(FMColor.fg1)
                .tracking(1.5)
            Text(subtitle)
                .font(FMFont.ui(FMFont.sm))
                .foregroundStyle(FMColor.fg3)
            content()
        }
    }
}

#Preview {
    DesignSystemView().preferredColorScheme(.dark)
}
