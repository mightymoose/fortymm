package com.fortymm.android.network

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals

abstract class LocalHttpTransportProbe {
    protected fun assertConfiguredClientReachesTheControlledLocalServer() {
        MockWebServer().use { server ->
            server.start(8080)
            server.enqueue(MockResponse().setResponseCode(204))

            assertEquals(204, ConfiguredApiClient().get("/v1/session").statusCode)
        }
    }
}
