import Foundation

extension String {
    /// Up to two uppercased initials drawn from the first two alphanumeric
    /// segments of a username (e.g. "gentle-jackdaw" → "GJ"). Falls back to
    /// "?" when there's nothing to draw from. Used for avatar monograms.
    var fmInitials: String {
        let letters = split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(2)
            .compactMap(\.first)
        let joined = String(letters).uppercased()
        return joined.isEmpty ? "?" : joined
    }
}
