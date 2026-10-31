import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Sends the jar's cookies with every request and keeps every cookie the API
/// sets. It also gives every `POST` a JSON `Content-Type`, because the API
/// answers 415 to one without, and the generator sets none on a `POST` with
/// no body.
struct CookieMiddleware: ClientMiddleware {
    let jar: CookieJar

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        if request.method == .post, request.headerFields[.contentType] == nil {
            request.headerFields[.contentType] = "application/json"
        }
        request.headerFields[.cookie] = jar.header
        let (response, responseBody) = try await next(request, body, baseURL)
        jar.apply(setCookie: response.headerFields[values: .setCookie])
        return (response, responseBody)
    }
}
