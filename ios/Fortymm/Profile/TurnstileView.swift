import SwiftUI
import WebKit

/// Imperative handle the parent holds to drive a `TurnstileView` — today just a
/// `reset()` to clear a spent token after a submit (Turnstile tokens are
/// single-use and expire ~300s after issue, so we mint a fresh one per attempt).
/// Mirrors the web client's `TurnstileHandle`. A plain command handle (no
/// observable state), held by the parent via `@State` and read by the
/// representable.
@MainActor
final class TurnstileController {
    fileprivate var onReset: (() -> Void)?

    func reset() { onReset?() }
}

/// Renders the Cloudflare Turnstile widget inside a `WKWebView` and surfaces the
/// resulting token to SwiftUI. Turnstile is a browser bot-deterrent with no
/// native SDK, so we host the widget in a tiny web page, capture its callback
/// via a JS message handler, and hand the token back — the same token the web
/// client posts as `captcha_token`, which the API validates through its
/// siteverify round-trip with no server-side branching.
///
/// The site key defaults to Cloudflare's documented always-passes test key
/// (`1x00000000000000000000AA`), matching the web client and the API's dev test
/// secret, so this works end-to-end against UAT with no extra setup. Point a
/// real, domain-locked key at it via the `FMM_TURNSTILE_SITE_KEY` scheme
/// environment variable for production; the page is loaded with the API host as
/// its origin so a domain-restricted key still validates.
struct TurnstileView: UIViewRepresentable {
    let controller: TurnstileController
    var onToken: (String) -> Void
    var onExpire: () -> Void = {}
    var onError: () -> Void = {}

    /// JS → Swift message channel name; shared by the handler registration and
    /// the `postMessage` calls in the page so the two can't drift.
    private static let messageName = "turnstile"

    static let siteKey: String =
        ProcessInfo.processInfo.environment["FMM_TURNSTILE_SITE_KEY"]
            ?? "1x00000000000000000000AA"

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let controllerJS = WKUserContentController()
        controllerJS.add(context.coordinator, name: Self.messageName)
        config.userContentController = controllerJS

        let webView = WKWebView(frame: .zero, configuration: config)
        // Let the dark app background show through the widget's margins.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false

        // Wire the reset handle to the page's helper. Assigning a plain stored
        // property (not @Published) during view setup doesn't publish, so this
        // doesn't trip "modifying state during view update".
        controller.onReset = { [weak webView] in
            webView?.evaluateJavaScript("window.fmmResetTurnstile && window.fmmResetTurnstile();")
        }

        // Load with the API host as the origin so a domain-locked production key
        // matches its allowed-hostnames list.
        webView.loadHTMLString(Self.html, baseURL: APIClient.baseURL)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    /// Tear down the message handler so the coordinator (which retains `self`)
    /// can be released and we don't leak across view identity changes.
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController
            .removeScriptMessageHandler(forName: messageName)
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        private let parent: TurnstileView
        init(_ parent: TurnstileView) { self.parent = parent }

        // Delivered on the main thread by WebKit, so forwarding into SwiftUI
        // state setters is safe.
        func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard
                let body = message.body as? [String: Any],
                let event = body["event"] as? String
            else { return }
            switch event {
            case "token":
                if let token = body["token"] as? String, !token.isEmpty {
                    parent.onToken(token)
                }
            case "expired":
                parent.onExpire()
            case "error":
                parent.onError()
            default:
                break
            }
        }
    }

    /// Minimal page that renders the widget explicitly (so we can keep its id
    /// for `reset`) and posts every lifecycle event back over the message
    /// channel. `interaction-only` keeps the UI minimal — invisible when no
    /// challenge is needed, matching the web client's appearance.
    private static var html: String {
        """
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
          <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=fmmOnTurnstileLoad" async defer></script>
          <style>
            html, body { margin: 0; padding: 0; background: transparent; }
            #cf { display: flex; justify-content: center; padding: 2px 0; }
          </style>
        </head>
        <body>
          <div id="cf"></div>
          <script>
            var fmmWidgetId;
            function fmmPost(event, token) {
              window.webkit.messageHandlers.\(messageName).postMessage({ event: event, token: token || "" });
            }
            function fmmResetTurnstile() {
              if (window.turnstile && fmmWidgetId !== undefined) {
                window.turnstile.reset(fmmWidgetId);
              }
            }
            window.fmmOnTurnstileLoad = function () {
              fmmWidgetId = window.turnstile.render('#cf', {
                sitekey: '\(siteKey)',
                theme: 'dark',
                appearance: 'interaction-only',
                callback: function (t) { fmmPost('token', t); },
                'expired-callback': function () { fmmPost('expired'); },
                'error-callback': function () { fmmPost('error'); }
              });
            };
          </script>
        </body>
        </html>
        """
    }
}
