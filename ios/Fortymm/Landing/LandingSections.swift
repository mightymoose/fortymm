import Combine
import SwiftUI

// MARK: - Features

struct LandingFeatures: View {
    @State private var tab = 0

    private struct Panel {
        let heading: String
        let body: String
        let bullets: [String]
    }

    private let tabs = ["Track matches", "See ratings", "Run tournaments", "Spectate"]

    private let panels: [Panel] = [
        Panel(heading: "Scores in, history out.",
              body: "Tap the score after every rally. Games end themselves — the app watches for deuce, win-by-2, change-of-ends. Save the match and it's on your profile, in your club feed, and in your head-to-head record.",
              bullets: ["Score with one finger on the bench",
                        "Auto-detect deuce & game point",
                        "Head-to-head and rating delta on save"]),
        Panel(heading: "A rating you can trust.",
              body: "Glicko-2 under the hood. Every match moves your number. Every number has a confidence range. Nothing is gamed, nothing is pay-to-win — because there's nothing to pay for.",
              bullets: ["Provisional → stable as you play",
                        "Separate singles and doubles ratings",
                        "Club-level and global leaderboards"]),
        Panel(heading: "The schedule, solved.",
              body: "Our scheduler treats your constraints as rules: how many courts, how long the lunch break, who can't play back-to-back. It returns a schedule that respects every one.",
              bullets: ["Round-robin, single-elim, double-elim, Swiss",
                        "Live scoring from the scorers' table",
                        "Public bracket link for spectators"]),
        Panel(heading: "Broadcast, without a broadcaster.",
              body: "Every tournament has a public spectator URL. Big type. Live scores. Upcoming matches on the right. Share it with anyone — works without an account, without an app.",
              bullets: ["Full-screen court view",
                        "Per-player follow links",
                        "Embed on your club's website"]),
    ]

    private let bullets: [(n: String, t: String, d: String)] = [
        ("01", "Match log", "Tap in scores. Games auto-advance. Rating delta shows up the moment you save."),
        ("02", "Clubs & ladders", "Every club gets a feed, a ladder, and a challenge board. Set it up in a minute."),
        ("03", "Smart schedules", "Constraints in, schedule out — fewer back-to-backs, smarter court assignments."),
        ("04", "Ephemeral accounts", "You get an account when you start playing. Upgrade it by adding an email — whenever."),
        ("05", "Live spectator view", "Share a link. Parents, friends, your grandma — they all get the live bracket."),
        ("06", "Export your data", "One JSON download. Full match history. It's yours. Delete your account and take it with you."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: FMSpace.s6) {
            LandingSectionHeading(eyebrow: "The product",
                                  line1: "Everything a club needs.",
                                  line2: "Nothing anyone would sell you.")

            FMTabs(items: tabs, selection: $tab)

            let panel = panels[tab]
            FMCard {
                VStack(alignment: .leading, spacing: FMSpace.s3) {
                    Text(panel.heading)
                        .font(FMFont.ui(FMFont.lg, weight: .semibold))
                        .foregroundStyle(FMColor.fg1)
                    Text(panel.body)
                        .font(FMFont.ui(FMFont.sm))
                        .foregroundStyle(FMColor.fg3)
                        .lineSpacing(2)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(panel.bullets, id: \.self) { b in
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(FMColor.serve500)
                                    .padding(.top, 2)
                                Text(b)
                                    .font(FMFont.ui(FMFont.sm))
                                    .foregroundStyle(FMColor.fg2)
                            }
                        }
                    }
                    .padding(.top, 2)
                }
            }

            VStack(spacing: FMSpace.s3) {
                ForEach(bullets, id: \.n) { b in
                    FMCard {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(b.n)
                                .font(FMFont.mono(FMFont.xs))
                                .foregroundStyle(FMColor.fgAccent)
                            Text(b.t)
                                .font(FMFont.ui(FMFont.md, weight: .semibold))
                                .foregroundStyle(FMColor.fg1)
                            Text(b.d)
                                .font(FMFont.ui(FMFont.sm))
                                .foregroundStyle(FMColor.fg3)
                                .lineSpacing(2)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, FMSpace.s5)
    }
}

// MARK: - Tournaments

struct LandingTournaments: View {
    private let steps: [(k: String, t: String)] = [
        ("01", "Import a player list — CSV, paste, or scan."),
        ("02", "Set constraints — courts, breaks, start times."),
        ("03", "Generate — and share the bracket link."),
        ("04", "Score live from the scorers' table."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: FMSpace.s6) {
            LandingSectionHeading(eyebrow: "For tournament directors",
                                  line1: "The math is quiet.",
                                  line2: "The rallies are loud.",
                                  line2Color: FMColor.ball500)

            Text("Running a tournament is a scheduling nightmare. Byes, constraints, courts, breaks, the player who drove four hours and can't go back-to-back. FortyMM's scheduler treats your constraints as rules and gives you a schedule that respects every one.")
                .font(FMFont.ui(FMFont.md))
                .foregroundStyle(FMColor.fg3)
                .lineSpacing(3)

            VStack(spacing: FMSpace.s3) {
                ForEach(steps, id: \.k) { s in
                    HStack(spacing: FMSpace.s3) {
                        Text(s.k)
                            .font(FMFont.mono(FMFont.sm, weight: .semibold))
                            .foregroundStyle(FMColor.fgAccent)
                        Text(s.t)
                            .font(FMFont.ui(FMFont.sm))
                            .foregroundStyle(FMColor.fg2)
                        Spacer()
                    }
                }
            }

            LandingSolverCard()

            VStack(spacing: FMSpace.s3) {
                FMButton(title: "Start a tournament", variant: .primary, size: .lg)
                    .frame(maxWidth: .infinity)
                FMButton(title: "See a sample schedule", variant: .ghost, size: .lg)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, FMSpace.s5)
    }
}

private struct LandingSolverCard: View {
    @State private var line = 0
    private let timer = Timer.publish(every: 1.2, on: .main, in: .common).autoconnect()

    private let lines: [(t: String, txt: String)] = [
        ("constraint", "32 players · 4 courts · 3 hr block"),
        ("constraint", "no back-to-back within 20 min"),
        ("constraint", "seeds 1–4 on court 1 in R16"),
        ("constraint", "lunch break 12:30–13:15"),
        ("solve", "schedule found in 287 ms"),
    ]

    var body: some View {
        FMCard {
            VStack(alignment: .leading, spacing: FMSpace.s3) {
                HStack {
                    Text("scheduler.fortymm")
                        .font(FMFont.mono(FMFont.xs))
                        .foregroundStyle(FMColor.fgMuted)
                    Spacer()
                    HStack(spacing: 4) {
                        ForEach(0..<3) { _ in
                            Circle().fill(FMColor.borderDefault).frame(width: 6, height: 6)
                        }
                    }
                }
                Rectangle().fill(FMColor.borderSubtle).frame(height: 1)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(0..<min(line + 1, lines.count), id: \.self) { i in
                        let l = lines[i]
                        HStack(spacing: 8) {
                            Text(l.t == "solve" ? "✓" : "›")
                                .foregroundStyle(l.t == "solve" ? FMColor.serve500 : FMColor.fgAccent)
                            Text(l.t.uppercased())
                                .foregroundStyle(FMColor.fgMuted)
                                .frame(width: 78, alignment: .leading)
                            Text(l.txt)
                                .foregroundStyle(FMColor.fg2)
                        }
                        .font(FMFont.mono(FMFont.xs))
                    }
                }

                if line >= lines.count {
                    solverGrid
                }
            }
        }
        .onReceive(timer) { _ in
            line = (line + 1) % (lines.count + 2)
        }
    }

    private var solverGrid: some View {
        VStack(spacing: 4) {
            ForEach(0..<4, id: \.self) { r in
                HStack(spacing: 4) {
                    Text("CT\(r + 1)")
                        .font(FMFont.mono(9))
                        .foregroundStyle(FMColor.fgMuted)
                        .frame(width: 28, alignment: .leading)
                    ForEach(0..<8, id: \.self) { c in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(cellColor(r, c))
                            .frame(height: 14)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    private func cellColor(_ r: Int, _ c: Int) -> Color {
        if (r + c) % 3 == 0 { return FMColor.ball500 }
        if (r + c) % 5 == 0 { return FMColor.serve500 }
        return FMColor.ink700
    }
}

// MARK: - Manifesto

struct LandingManifesto: View {
    private let promises: [(n: String, t: String, d: String)] = [
        ("01", "No ads. Not now, not ever.", "Every other sports-tracker ends up plastered in sportsbook banners. Ours won't. That's a commitment, not a roadmap item."),
        ("02", "No premium tier.", "Every feature works for everyone. No unlocks. No trials. No \"upgrade to see the full bracket\" garbage."),
        ("03", "We don't sell your data.", "No trackers. No third-party analytics. No cookie-consent theater. We keep what the app needs. Nothing else."),
        ("04", "Accounts are optional.", "You get one the moment you open the app. Your matches are tracked immediately. Add an email when — or if — you want to keep them forever."),
        ("05", "Your data is yours.", "One-click export. One-click anonymize. Your name, photo, and email vanish from every record, instantly."),
        ("06", "Open-source, GPLv3.", "Read the code. Self-host if you want. If we ever do something shady, fork us."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: FMSpace.s6) {
            LandingSectionHeading(eyebrow: "Manifesto",
                                  line1: "Six promises.",
                                  line2: "Zero asterisks.",
                                  line2Color: FMColor.ball500)

            Text("Most sports-tracker apps start free, then put the good stuff behind a paywall, then start selling your data, then go out of business. We're doing none of those things. Here's the commitment in writing.")
                .font(FMFont.ui(FMFont.sm))
                .foregroundStyle(FMColor.fg3)
                .lineSpacing(2)

            VStack(spacing: FMSpace.s3) {
                ForEach(promises, id: \.n) { p in
                    FMCard {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(p.n)
                                .font(FMFont.mono(FMFont.xs))
                                .foregroundStyle(FMColor.fgAccent)
                            Text(p.t)
                                .font(FMFont.ui(FMFont.md, weight: .semibold))
                                .foregroundStyle(FMColor.fg1)
                            Text(p.d)
                                .font(FMFont.ui(FMFont.sm))
                                .foregroundStyle(FMColor.fg3)
                                .lineSpacing(2)
                        }
                    }
                }
            }

            founder
        }
        .padding(.horizontal, FMSpace.s5)
    }

    private var founder: some View {
        FMCard(featured: true) {
            VStack(alignment: .leading, spacing: FMSpace.s3) {
                FMEyebrow(text: "Made by players")
                Text("“I run a small club in the back of a community center. Every Tuesday it's 24 people and one chalkboard. I got tired of apps that wanted my email, my credit card, and my grandmother's maiden name just to log a best-of-five. So I built this with a few friends. It's free because that's the whole point.”")
                    .font(FMFont.ui(FMFont.md))
                    .foregroundStyle(FMColor.fg2)
                    .lineSpacing(3)
                HStack(spacing: FMSpace.s3) {
                    FMAvatar(initials: "TN", size: 40, color: FMColor.ball500, foreground: FMColor.fgInverse)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("T. Nguyen")
                            .font(FMFont.ui(FMFont.sm, weight: .semibold))
                            .foregroundStyle(FMColor.fg1)
                        Text("Founder · Rated 2145 · Will beat you at short pips")
                            .font(FMFont.ui(FMFont.xs))
                            .foregroundStyle(FMColor.fgMuted)
                    }
                }
            }
        }
    }
}

// MARK: - FAQ

struct LandingFAQ: View {
    @State private var open = 0

    private let qs: [(q: String, a: String)] = [
        ("Is it really free?", "Yes. Free forever, no credit card, no \"try it free\" gotcha. We're players. Running the servers costs about the price of a nice paddle per month. We're fine."),
        ("Do I need an account?", "No. The first time you open the app we quietly give you an ephemeral account — your matches and ratings start tracking immediately. Add an email any time to upgrade it to a real account."),
        ("How does the rating work?", "Glicko-2 — a modern rating system that tracks both your skill and the uncertainty around it. Play more, uncertainty drops. Beat a higher-rated player, you gain more."),
        ("Can I run a tournament?", "Yes — that's half the product. Round-robin, single-elim, double-elim, Swiss, custom. Our scheduler respects your constraints. Free for any club, any size, any country."),
        ("How do you make money?", "We don't. The project is funded out-of-pocket and accepts small donations from clubs that want to. No investors, no runway, no growth team."),
        ("Can I self-host it?", "Yes. The whole stack is open source. Docker compose, one command, on a $5 VPS. The data is portable and the code is yours."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: FMSpace.s6) {
            LandingSectionHeading(eyebrow: "FAQ",
                                  line1: "Short answers",
                                  line2: "to what everyone asks.")

            VStack(spacing: FMSpace.s3) {
                ForEach(Array(qs.enumerated()), id: \.offset) { i, item in
                    FMCard {
                        VStack(alignment: .leading, spacing: FMSpace.s3) {
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    open = open == i ? -1 : i
                                }
                            } label: {
                                HStack(alignment: .firstTextBaseline, spacing: FMSpace.s3) {
                                    Text(String(format: "%02d", i + 1))
                                        .font(FMFont.mono(FMFont.xs))
                                        .foregroundStyle(FMColor.fgAccent)
                                    Text(item.q)
                                        .font(FMFont.ui(FMFont.md, weight: .semibold))
                                        .foregroundStyle(FMColor.fg1)
                                        .multilineTextAlignment(.leading)
                                    Spacer()
                                    Image(systemName: open == i ? "minus" : "plus")
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundStyle(FMColor.fgMuted)
                                }
                            }
                            .buttonStyle(.plain)

                            if open == i {
                                Text(item.a)
                                    .font(FMFont.ui(FMFont.sm))
                                    .foregroundStyle(FMColor.fg3)
                                    .lineSpacing(2)
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, FMSpace.s5)
    }
}

// MARK: - Final CTA

struct LandingCTA: View {
    var body: some View {
        FMCard(featured: true) {
            VStack(alignment: .leading, spacing: FMSpace.s4) {
                FMEyebrow(text: "One tap. No form.")
                VStack(alignment: .leading, spacing: 0) {
                    Text("Open FortyMM.")
                        .foregroundStyle(FMColor.fg1)
                    Text("Play your first match.")
                        .foregroundStyle(FMColor.ball500)
                }
                .font(FMFont.display(40))
                Text("We give you an account the moment the app loads. Your first match is already being tracked. If you ever want to keep it, add an email.")
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .lineSpacing(2)
                FMButton(title: "Start playing now", variant: .primary, size: .lg)
                    .frame(maxWidth: .infinity)
                Text("● Web is live · iOS in beta · Android in beta")
                    .font(FMFont.mono(FMFont.xs))
                    .foregroundStyle(FMColor.serve500)
            }
        }
        .padding(.horizontal, FMSpace.s5)
    }
}

// MARK: - Footer

struct LandingFooter: View {
    private let cols: [(h: String, items: [String])] = [
        ("Product", ["Web app", "iOS (beta)", "Android (beta)", "Spectator view"]),
        ("Directors", ["Run a tournament", "Scheduler", "Sample draws"]),
        ("Community", ["Discord", "GitHub", "Clubs map", "Contribute"]),
        ("Never", ["Ads", "Trackers", "Premium", "Cookie banners"]),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: FMSpace.s5) {
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1)

            FMLogo(size: 22)
            Text("Made by players, in basements and rec centers.\n© 2026 FortyMM. GPLv3. For the love of the game.")
                .font(FMFont.ui(FMFont.xs))
                .foregroundStyle(FMColor.fgMuted)
                .lineSpacing(2)

            FlowLayout(spacing: 24, lineSpacing: 20) {
                ForEach(cols, id: \.h) { col in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(col.h.uppercased())
                            .font(FMFont.mono(9))
                            .tracking(1)
                            .foregroundStyle(FMColor.fg2)
                        ForEach(col.items, id: \.self) { item in
                            Text(item)
                                .font(FMFont.ui(FMFont.sm))
                                .foregroundStyle(FMColor.fgMuted)
                        }
                    }
                }
            }

            Rectangle().fill(FMColor.borderSubtle).frame(height: 1)
            HStack {
                Text("v0.9.0 · status: operational")
                Spacer()
                Text("Play more. Pay never.")
            }
            .font(FMFont.mono(FMFont.xs))
            .foregroundStyle(FMColor.fgMuted)
        }
        .padding(.horizontal, FMSpace.s5)
    }
}

#Preview {
    ScrollView {
        VStack(spacing: FMSpace.s16) {
            LandingFeatures()
            LandingTournaments()
            LandingManifesto()
            LandingFAQ()
            LandingCTA()
            LandingFooter()
        }
        .padding(.vertical, FMSpace.s8)
    }
    .background(FMColor.bgApp)
    .preferredColorScheme(.dark)
}
