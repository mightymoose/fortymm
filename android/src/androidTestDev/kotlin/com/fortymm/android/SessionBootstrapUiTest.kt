package com.fortymm.android

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.fortymm.android.network.FortyMMApiClient
import com.fortymm.android.session.SessionEndCode
import com.fortymm.android.session.SessionEndReason
import com.fortymm.android.session.SessionOwner
import org.junit.Assert.assertEquals
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class SessionBootstrapUiTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun appRendersTheUsernameFromTheRealHttpDecoderAndSessionOwner() {
        val userId = UUID.fromString("2600f567-bc78-4701-884b-6b4f1fd24244")
        MockWebServer().use { server ->
            server.start()
            server.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .setHeader("Content-Type", "application/json")
                    .addHeader("Set-Cookie", "session=ui-session; Path=/; HttpOnly")
                    .addHeader("Set-Cookie", "csrf_token=ui-csrf; Path=/")
                    .setBody(
                        """
                        {"data":{"user":{"id":"$userId","username":"api-returned-guest","permissions":[]}}}
                        """.trimIndent(),
                    ),
            )
            val owner = SessionOwner(
                apiClient = FortyMMApiClient(server.url("/")),
                credentialStore = InMemorySessionCredentialStore(),
            )
            composeRule.setContent { FortyMMApp(owner) }

            composeRule.waitUntil(timeoutMillis = 5_000) {
                composeRule.onAllNodesWithText("api-returned-guest")
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            composeRule.onNodeWithText("api-returned-guest").assertIsDisplayed()
        }
    }

    @Test
    fun relaunchWhileSignedOutShowsRecoveryWithoutAnyRequest() {
        MockWebServer().use { server ->
            server.start()
            val owner = SessionOwner(
                apiClient = FortyMMApiClient(server.url("/")),
                credentialStore = InMemorySessionCredentialStore(
                    sessionEndReason = SessionEndReason(SessionEndCode.Ended),
                ),
            )
            composeRule.setContent { FortyMMApp(owner) }

            composeRule.waitUntil(timeoutMillis = 5_000) {
                composeRule.onAllNodesWithText("Signed out")
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            composeRule.onNodeWithText("You've been signed out.").assertIsDisplayed()
            composeRule.onNodeWithText("Continue as a new guest").assertIsDisplayed()
            assertEquals(0, server.requestCount)
        }
    }

    @Test
    fun mergedGuestShowsRecoveryWithoutANonworkingSignInPath() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(
                MockResponse()
                    .setResponseCode(401)
                    .setHeader("Content-Type", "application/json")
                    .setBody(
                        """
                        {"detail":{"code":"session_merged","message":"This guest session was merged into your account. Sign in to continue.","email":"owner@example.com"}}
                        """.trimIndent(),
                    ),
            )
            val owner = SessionOwner(
                apiClient = FortyMMApiClient(server.url("/")),
                credentialStore = InMemorySessionCredentialStore(credential = "merged-away-session"),
            )
            composeRule.setContent { FortyMMApp(owner) }

            composeRule.waitUntil(timeoutMillis = 5_000) {
                composeRule.onAllNodesWithText("Signed out")
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            composeRule.onNodeWithText("This guest was merged into an account.").assertIsDisplayed()
            composeRule.onNodeWithText("Continue as a new guest").assertIsDisplayed()
            composeRule.onAllNodesWithText("Sign in", substring = true).assertCountEquals(0)
            composeRule.onAllNodesWithText("owner@example.com", substring = true).assertCountEquals(0)
        }
    }

}
