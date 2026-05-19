import SwiftUI

struct FMTextField: View {
    let label: String
    var placeholder: String = ""
    var helper: String? = nil
    var error: String? = nil
    var required: Bool = false
    var disabled: Bool = false
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 2) {
                Text(label)
                    .font(FMFont.ui(FMFont.sm, weight: .medium))
                    .foregroundStyle(FMColor.fg2)
                if required {
                    Text("*").foregroundStyle(FMColor.loss)
                }
            }
            TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(FMColor.fgMuted))
                .font(FMFont.ui(FMFont.base))
                .foregroundStyle(FMColor.fg1)
                .padding(.horizontal, 12)
                .frame(height: 40)
                .background(FMColor.bgCard)
                .fmRoundedBorder(radius: FMRadius.md, color: error != nil ? FMColor.loss : FMColor.borderSubtle)
                .disabled(disabled)
                .opacity(disabled ? 0.5 : 1)
            if let error {
                Text(error)
                    .font(FMFont.ui(FMFont.xs))
                    .foregroundStyle(FMColor.loss)
            } else if let helper {
                Text(helper)
                    .font(FMFont.ui(FMFont.xs))
                    .foregroundStyle(FMColor.fgMuted)
            }
        }
    }
}
