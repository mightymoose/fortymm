package com.fortymm.android.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ReleaseTransportTest {
    @Test
    fun releaseClientIsPinnedToTheUatHttpsEndpoint() {
        assertEquals("https", ConfiguredApiClient().baseUrl.protocol)
        assertEquals("uat.fortymm.com", ConfiguredApiClient().baseUrl.host)
        assertEquals(-1, ConfiguredApiClient().baseUrl.port)
    }

    @Test
    fun releaseTransportRefusesTheControlledLocalHttpServer() {
        MockWebServer().use { server ->
            server.start(8081)
            server.enqueue(MockResponse().setResponseCode(204))

            assertThrows(IOException::class.java) {
                (URL(server.url("/").toString()).openConnection() as HttpURLConnection).responseCode
            }
            assertEquals(0, server.requestCount)
        }
    }
}
