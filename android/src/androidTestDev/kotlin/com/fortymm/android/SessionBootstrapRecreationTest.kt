package com.fortymm.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.fortymm.android.network.FortyMMApiClient
import com.fortymm.android.session.SessionOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class SessionBootstrapRecreationTest {
    @get:Rule
    val composeRule = createEmptyComposeRule()

    @Test
    fun rotatingWhileBootstrapIsPendingKeepsOneGuestAndRendersItsReadyState() {
        val userId = UUID.fromString("69cb48f9-2e25-452a-b673-ecb050852af8")
        val responseGate = HeldResponse(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .addHeader("Set-Cookie", "session=rotated-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=rotated-csrf; Path=/")
                .setBody(
                    """
                    {
                      "data": {
                        "user": {
                          "id": "$userId",
                          "username": "rotation-kept-guest",
                          "permissions": [],
                          "email": null,
                          "confirmed_at": null,
                          "pending_email": null
                        }
                      },
                      "merged": null
                    }
                    """.trimIndent(),
                ),
        )
        val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

        MockWebServer().use { server ->
            server.dispatcher = responseGate.dispatcher
            server.start()
            SessionOwnerTestRegistry.sessionOwner = SessionOwner(
                apiClient = FortyMMApiClient(server.url("/")),
                credentialStore = InMemorySessionCredentialStore(),
                applicationScope = applicationScope,
            )

            try {
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    responseGate.awaitRequest()
                    scenario.recreate()
                    composeRule.waitForIdle()

                    assertEquals(1, server.requestCount)
                    responseGate.release()
                    composeRule.waitUntil(timeoutMillis = 5_000) {
                        composeRule.onAllNodesWithText("rotation-kept-guest")
                            .fetchSemanticsNodes()
                            .isNotEmpty()
                    }

                    composeRule.onNodeWithText("rotation-kept-guest").assertIsDisplayed()
                    assertEquals(1, server.requestCount)
                }
            } finally {
                responseGate.release()
                SessionOwnerTestRegistry.sessionOwner = null
                applicationScope.cancel()
            }
        }
    }

    private class HeldResponse(private val response: MockResponse) {
        private val requestReceived = CountDownLatch(1)
        private val responseReleased = CountDownLatch(1)

        val dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requestReceived.countDown()
                responseReleased.await()
                return response
            }
        }

        fun awaitRequest() {
            check(requestReceived.await(5, TimeUnit.SECONDS)) {
                "Expected the session bootstrap request"
            }
        }

        fun release() {
            responseReleased.countDown()
        }
    }

}
