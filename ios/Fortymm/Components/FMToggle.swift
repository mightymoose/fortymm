import SwiftUI

struct FMSwitch: View {
    let label: String
    @Binding var isOn: Bool

    var body: some View {
        HStack {
            Text(label)
                .font(FMFont.ui(FMFont.sm))
                .foregroundStyle(FMColor.fg2)
            Spacer()
            Toggle("", isOn: $isOn)
                .labelsHidden()
                .tint(FMColor.ball500)
        }
    }
}

struct FMCheckbox: View {
    let label: String
    @Binding var isChecked: Bool
    var disabled: Bool = false

    var body: some View {
        Button {
            if !disabled { isChecked.toggle() }
        } label: {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(isChecked ? FMColor.ball500 : Color.clear)
                        .frame(width: 18, height: 18)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .stroke(isChecked ? FMColor.ball500 : FMColor.borderDefault, lineWidth: 1.5)
                        )
                    if isChecked {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(FMColor.fgInverse)
                    }
                }
                Text(label)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(disabled ? FMColor.fgDisabled : FMColor.fg2)
                Spacer()
            }
        }
        .buttonStyle(.plain)
        .opacity(disabled ? 0.6 : 1)
    }
}

struct FMRadio: View {
    let label: String
    let value: String
    @Binding var selection: String

    var isSelected: Bool { selection == value }

    var body: some View {
        Button { selection = value } label: {
            HStack(spacing: 10) {
                ZStack {
                    Circle()
                        .stroke(isSelected ? FMColor.ball500 : FMColor.borderDefault, lineWidth: 1.5)
                        .frame(width: 18, height: 18)
                    if isSelected {
                        Circle().fill(FMColor.ball500).frame(width: 9, height: 9)
                    }
                }
                Text(label)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg2)
                Spacer()
            }
        }
        .buttonStyle(.plain)
    }
}
