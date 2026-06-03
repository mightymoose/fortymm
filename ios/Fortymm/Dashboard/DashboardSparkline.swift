import SwiftUI

/// A compact rating sparkline: a gradient-filled area under a stroked line with
/// a marker on the latest point. Mirrors the SVG `Sparkline` in
/// `web-client/src/components/dashboard/dashboard-page.tsx`.
///
/// Needs ≥2 points to draw a line; a single point (or none) renders a flat
/// baseline so the freshly-rated case still looks intentional.
struct DashboardSparkline: View {
    let data: [Double]
    var color: Color = FMColor.ball500
    var height: CGFloat = 48

    private var points: [Double] {
        switch data.count {
        case 0: return [0, 0]
        case 1: return [data[0], data[0]]
        default: return data
        }
    }

    var body: some View {
        GeometryReader { geo in
            let pts = positions(in: geo.size)
            ZStack {
                // Gradient fill under the curve.
                areaPath(through: pts, height: geo.size.height)
                    .fill(
                        LinearGradient(
                            colors: [color.opacity(0.35), color.opacity(0)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                // The line itself.
                linePath(through: pts)
                    .stroke(
                        color,
                        style: StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round)
                    )
                // Latest-point marker with a soft halo.
                if let last = pts.last {
                    Circle().fill(color.opacity(0.25)).frame(width: 10, height: 10).position(last)
                    Circle().fill(color).frame(width: 5.2, height: 5.2).position(last)
                }
            }
        }
        .frame(height: height)
    }

    private func positions(in size: CGSize) -> [CGPoint] {
        let pts = points
        let minV = pts.min() ?? 0
        let maxV = pts.max() ?? 0
        let range = (maxV - minV) == 0 ? 1 : (maxV - minV)
        let pad: CGFloat = 3
        let n = max(pts.count - 1, 1)
        return pts.enumerated().map { i, v in
            let x = pad + (CGFloat(i) / CGFloat(n)) * (size.width - pad * 2)
            let y = size.height - pad - CGFloat((v - minV) / range) * (size.height - pad * 2)
            return CGPoint(x: x, y: y)
        }
    }

    /// The open polyline through all points — shared by the stroked line and
    /// the gradient area, which just closes it down to the baseline.
    private func linePath(through pts: [CGPoint]) -> Path {
        Path { p in
            guard let first = pts.first else { return }
            p.move(to: first)
            pts.dropFirst().forEach { p.addLine(to: $0) }
        }
    }

    private func areaPath(through pts: [CGPoint], height: CGFloat) -> Path {
        guard let first = pts.first, let last = pts.last else { return Path() }
        var p = linePath(through: pts)
        p.addLine(to: CGPoint(x: last.x, y: height))
        p.addLine(to: CGPoint(x: first.x, y: height))
        p.closeSubpath()
        return p
    }
}

#Preview {
    DashboardSparkline(data: [1500, 1480, 1465, 1440, 1410, 1380, 1320, 1290, 1260, 1249])
        .padding()
        .frame(width: 300)
        .background(FMColor.bgPanel)
        .preferredColorScheme(.dark)
}
