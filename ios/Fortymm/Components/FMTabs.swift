import SwiftUI

struct FMTabs: View {
    let items: [String]
    @Binding var selection: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<items.count, id: \.self) { i in
                Button {
                    selection = i
                } label: {
                    Text(items[i])
                        .font(FMFont.ui(FMFont.sm, weight: .medium))
                        .foregroundStyle(selection == i ? FMColor.fg1 : FMColor.fg3)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(selection == i ? FMColor.bgRaised : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: FMRadius.sm, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(FMColor.bgCard.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: FMRadius.md, style: .continuous))
    }
}

struct FMProgress: View {
    let label: String
    let value: Double // 0...1
    let trailing: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(FMFont.ui(FMFont.sm)).foregroundStyle(FMColor.fg2)
                Spacer()
                Text(trailing).font(FMFont.mono(FMFont.xs)).foregroundStyle(FMColor.fgMuted)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 999).fill(FMColor.bgRaised)
                    RoundedRectangle(cornerRadius: 999)
                        .fill(FMColor.ball500)
                        .frame(width: geo.size.width * value)
                }
            }
            .frame(height: 6)
        }
    }
}

struct FMSkeletonRow: View {
    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(FMColor.bgRaised).frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4).fill(FMColor.bgRaised).frame(height: 10)
                RoundedRectangle(cornerRadius: 4).fill(FMColor.bgRaised).frame(width: 180, height: 10)
            }
        }
    }
}
