package com.fortymm.android.network

import com.fortymm.android.BuildConfig
import java.net.HttpURLConnection
import java.net.URL

/** The sole HTTP transport used by FortyMM Android features. */
class ConfiguredApiClient(
    private val transport: ApiTransport = UrlConnectionTransport,
) {
    val baseUrl = URL(BuildConfig.API_BASE_URL)

    fun get(path: String): TransportResponse {
        return transport.get(URL(baseUrl, path.removePrefix("/")))
    }
}

interface ApiTransport {
    fun get(url: URL): TransportResponse
}

internal object UrlConnectionTransport : ApiTransport {
    override fun get(url: URL): TransportResponse {
        val connection = url.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            TransportResponse(connection.responseCode)
        } finally {
            connection.disconnect()
        }
    }
}

data class TransportResponse(val statusCode: Int)
