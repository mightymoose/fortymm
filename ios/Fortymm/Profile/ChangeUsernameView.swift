import SwiftUI

/// Sheet for changing the handle other players find you by (`PATCH /v1/me`).
/// Validates client-side for fast feedback, but the server owns the final word
/// — a 409 (taken) or 422 (malformed) comes back as an inline error. On success
/// the refreshed user is folded into `SessionStore` and the sheet dismisses.
struct ChangeUsernameView: View {
    let current: String
    var onDone: () -> Void

    @EnvironmentObject private var session: SessionStore
    private let service = ProfileService.shared

    @State private var value: String
    @State private var touched = false
    @State private var serverError: String?
    @State private var saving = false
    @FocusState private var focused: Bool

    init(current: String, onDone: @escaping () -> Void) {
        self.current = current
        self.onDone = onDone
        _value = State(initialValue: current)
    }

    private var clientValidation: FieldValidation { ProfileRules.username(value) }
    private var dirty: Bool { value != current }
    private var canSave: Bool { clientValidation.ok && dirty && !saving }

    // Show character-set errors immediately (the user just typed something
    // disallowed); gate length errors on blur so we don't nag mid-type.
    private var displayedError: String? {
        ProfileRules.displayError(
            clientValidation,
            serverError: serverError,
            show: touched || ProfileRules.usernameHasInvalidChar(value)
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            EditorHeader(title: "Username", onCancel: onDone) {
                EditorActionButton(title: "Save", loading: saving, enabled: canSave) {
                    Task { await save() }
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    field
                    preview
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 28)
            }
        }
        .background(FMColor.ink950.ignoresSafeArea())
        .onAppear { focused = true }
    }

    private var field: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Eyebrow("Username")
                Spacer()
                Text("\(value.count)/\(ProfileRules.usernameMax)")
                    .font(FMFont.mono(11))
                    .foregroundStyle(
                        value.count > ProfileRules.usernameMax ? FMColor.loss : FMColor.fgMuted
                    )
            }
            HStack(spacing: 0) {
                Text("@")
                    .font(FMFont.mono(15))
                    .foregroundStyle(FMColor.fgMuted)
                    .padding(.leading, 12)
                TextField(
                    "",
                    text: $value,
                    prompt: Text("your-name").foregroundStyle(FMColor.fgMuted)
                )
                .font(FMFont.mono(15))
                .foregroundStyle(FMColor.fg1)
                .focused($focused)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.done)
                .onSubmit { Task { await save() } }
                .padding(.horizontal, 6)
                .onChange(of: value) { _, _ in if serverError != nil { serverError = nil } }
            }
            .frame(height: 44)
            .background(FMColor.ink800)
            .fmRoundedBorder(
                radius: FMRadius.md,
                color: displayedError != nil ? FMColor.loss : FMColor.borderSubtle
            )

            if let displayedError {
                Text(displayedError)
                    .font(FMFont.ui(FMFont.xs))
                    .foregroundStyle(FMColor.loss)
            } else if dirty, clientValidation.ok {
                Text("Looks good. Save to make it stick.")
                    .font(FMFont.ui(FMFont.xs))
                    .foregroundStyle(FMColor.win)
            } else {
                Text(
                    "Lowercase letters, numbers, dots, hyphens and underscores. "
                        + "\(ProfileRules.usernameMin)–\(ProfileRules.usernameMax) characters."
                )
                .font(FMFont.ui(FMFont.xs))
                .foregroundStyle(FMColor.fgMuted)
            }
        }
    }

    private var preview: some View {
        HStack(spacing: 14) {
            FMAvatar(
                initials: value.fmInitials,
                size: 38,
                color: clientValidation.ok ? FMColor.ink600 : FMColor.ink700,
                foreground: clientValidation.ok ? FMColor.fg2 : FMColor.fgMuted
            )
            VStack(alignment: .leading, spacing: 2) {
                Eyebrow("Preview")
                Text(clientValidation.ok ? "@\(value)" : "—")
                    .font(FMFont.mono(15))
                    .foregroundStyle(FMColor.fg1)
            }
            Spacer()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.bgPanel)
        .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderSubtle)
    }

    private func save() async {
        guard canSave else { return }
        serverError = nil
        saving = true
        defer { saving = false }
        do {
            let user = try await service.updateUsername(value)
            session.apply(user)
            onDone()
        } catch {
            serverError = error.fmMessage
        }
    }
}
