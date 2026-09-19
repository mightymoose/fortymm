package com.fortymm.android.network

import com.fortymm.android.BuildConfig
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import java.util.UUID

abstract class LocalHttpTransportProbe {
    protected fun assertConfiguredClientReachesTheControlledLocalServer() = runBlocking {
        MockWebServer().use { server ->
            server.start(8080)
            val userId = UUID.fromString("d03f8c29-44d0-4a04-92b7-c06a8560ec43")
            server.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .setHeader("Content-Type", "application/json")
                    .addHeader("Set-Cookie", "session=transport-session; Path=/; HttpOnly")
                    .addHeader("Set-Cookie", "csrf_token=transport-csrf; Path=/")
                    .setBody(
                        """
                        {"data":{"user":{"id":"$userId","username":"transport-guest","permissions":[]}}}
                        """.trimIndent(),
                    ),
            )

            val session = FortyMMApiClient(BuildConfig.API_BASE_URL.toHttpUrl()).bootstrap(null)

            assertEquals(userId, session.user.id)
            assertEquals("transport-guest", session.user.username)
        }
    }
}
