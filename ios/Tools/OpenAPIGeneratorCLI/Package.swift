// swift-tools-version: 5.9
import PackageDescription

/// Not part of the Fortymm app — a standalone SPM manifest whose sole purpose
/// is pinning `swift-openapi-generator` so `swift run swift-openapi-generator
/// generate ...` produces the same output on every machine and in CI.
/// Invoked by `mise run regen-ios-api-types` (see root mise.toml) and by the
/// `openapi-schema` CI workflow; never built as part of an Xcode build.
let package = Package(
    name: "openapi-generator-cli",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.12.2")
    ]
)
