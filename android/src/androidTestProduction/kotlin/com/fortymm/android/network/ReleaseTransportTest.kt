package com.fortymm.android.network

import com.fortymm.android.BuildConfig
import java.io.IOException
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseTransportTest {
    @Test
    fun releaseClientIsPinnedToTheUatHttpsEndpoint() {
        val baseUrl = BuildConfig.API_BASE_URL.toHttpUrl()
        assertEquals("https", baseUrl.scheme)
        assertEquals("uat.fortymm.com", baseUrl.host)
        assertEquals(443, baseUrl.port)
    }

    @Test
    fun releaseTransportRefusesTheControlledLocalHttpServer() = runBlocking {
        MockWebServer().use { server ->
            server.start(8081)
            server.enqueue(MockResponse().setResponseCode(204))

            val failure = runCatching {
                FortyMMApiClient(server.url("/")).bootstrap(null)
            }.exceptionOrNull()

            assertTrue(failure is IOException)
            assertEquals(0, server.requestCount)
        }
    }
}
