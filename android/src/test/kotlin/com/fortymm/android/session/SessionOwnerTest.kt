package com.fortymm.android.session

import com.fortymm.android.network.FortyMMApiClient
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.util.UUID

class SessionOwnerTest {
    private lateinit var server: MockWebServer

    @Before
    fun startServer() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stopServer() {
        server.shutdown()
    }

    @Test
    fun freshLaunchCreatesGuestAndLaterProcessLaunchRestoresTheSameUserId() = runBlocking {
        val userId = UUID.fromString("7e78cc59-348d-4372-9eab-019cbb39f2a8")
        val credentialStore = MemoryCredentialStore()
        server.enqueue(
            sessionResponse(userId, "api-returned-guest")
                .addHeader("Set-Cookie", "session=guest-session-token; Path=/; HttpOnly; SameSite=lax")
                .addHeader("Set-Cookie", "csrf_token=first-csrf; Path=/; SameSite=lax"),
        )

        val firstProcess = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )
        firstProcess.bootstrap()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "api-returned-guest")),
            firstProcess.state.value,
        )
        assertEquals("guest-session-token", credentialStore.credential)
        assertEquals(null, server.takeRequest().getHeader("Cookie"))

        server.enqueue(
            sessionResponse(userId, "renamed-on-server")
                .addHeader("Set-Cookie", "csrf_token=restored-csrf; Path=/; SameSite=lax"),
        )
        val laterProcess = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )
        laterProcess.bootstrap()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "renamed-on-server")),
            laterProcess.state.value,
        )
        assertEquals(
            "session=guest-session-token",
            server.takeRequest().getHeader("Cookie"),
        )
    }

    @Test
    fun existingSessionRestoresItsRootScopedCsrfCompanionWithoutReplacingIdentity() = runBlocking {
        val userId = UUID.fromString("48e21096-99c6-481d-bbe4-98e10354dc62")
        val credentialStore = MemoryCredentialStore().apply {
            credential = "durable-session-token"
        }
        server.enqueue(
            sessionResponse(userId, "restored-guest")
                .addHeader("Set-Cookie", "session=wrong-path-session; Path=/v1; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=wrong-path-csrf; Path=/v1")
                .addHeader("Set-Cookie", "csrf_token=restored-csrf; Path=/"),
        )
        val apiClient = FortyMMApiClient(server.url("/"))
        val owner = SessionOwner(apiClient, credentialStore)

        owner.bootstrap()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "restored-guest")),
            owner.state.value,
        )
        assertEquals("durable-session-token", credentialStore.credential)
        assertEquals("durable-session-token", apiClient.sessionCredential)
        assertEquals("restored-csrf", apiClient.csrfToken)
        assertEquals("session=durable-session-token", server.takeRequest().getHeader("Cookie"))
    }

    @Test
    fun failedCredentialWriteRetrySavesReceivedGuestWithoutCreatingAnotherOne() = runBlocking {
        val userId = UUID.fromString("9a0b75b9-1b31-4e50-97dc-dd7c3017cbdc")
        val credentialStore = MemoryCredentialStore(failedSavesRemaining = 1)
        server.enqueue(
            sessionResponse(userId, "guest-kept-in-memory")
                .addHeader("Set-Cookie", "session=pending-session-token; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=pending-csrf; Path=/"),
        )
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )

        owner.bootstrap()

        assertEquals(
            SessionState.RetryableStartup(
                "We couldn't protect your session on this device. Please try again.",
            ),
            owner.state.value,
        )
        assertEquals(1, server.requestCount)

        owner.bootstrap()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "guest-kept-in-memory")),
            owner.state.value,
        )
        assertEquals("pending-session-token", credentialStore.credential)
        assertEquals(2, credentialStore.saveCount)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun unreadableCredentialStorageDoesNotCreateACookielessGuest() = runBlocking {
        val credentialStore = MemoryCredentialStore(unreadable = true)
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )

        owner.bootstrap()

        assertEquals(
            SessionState.RetryableStartup(
                "We couldn't read your saved session. Please try again.",
            ),
            owner.state.value,
        )
        assertEquals(0, server.requestCount)
    }

    @Test
    fun crossOriginBootstrapResponseCannotReplaceTheSession() = runBlocking {
        val userId = UUID.fromString("adf47800-ed82-4efe-bc1c-430058d5a677")
        val credentialStore = MemoryCredentialStore().apply {
            credential = "durable-session-token"
        }
        MockWebServer().use { otherOrigin ->
            otherOrigin.start()
            server.enqueue(
                MockResponse()
                    .setResponseCode(302)
                    .setHeader("Location", otherOrigin.url("/v1/session")),
            )
            otherOrigin.enqueue(
                sessionResponse(userId, "redirected-guest")
                    .addHeader("Set-Cookie", "session=redirected-session; Path=/; HttpOnly")
                    .addHeader("Set-Cookie", "csrf_token=redirected-csrf; Path=/"),
            )
            val owner = SessionOwner(
                apiClient = FortyMMApiClient(server.url("/")),
                credentialStore = credentialStore,
            )

            owner.bootstrap()

            assertEquals(
                SessionState.RetryableStartup(
                    "We couldn't start FortyMM. Check your connection and try again.",
                ),
                owner.state.value,
            )
            assertEquals("durable-session-token", credentialStore.credential)
        }
    }

    private fun sessionResponse(userId: UUID, username: String) = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(
            """
            {
              "data": {
                "user": {
                  "id": "$userId",
                  "username": "$username",
                  "permissions": [],
                  "email": null,
                  "confirmed_at": null,
                  "pending_email": null
                }
              },
              "merged": null
            }
            """.trimIndent(),
        )

    private class MemoryCredentialStore(
        var failedSavesRemaining: Int = 0,
        var unreadable: Boolean = false,
    ) : SessionCredentialStore {
        var credential: String? = null
        var saveCount = 0

        override fun load(): CredentialLoadResult = when {
            unreadable -> CredentialLoadResult.UnreadableStorage
            credential != null -> CredentialLoadResult.Credential(credential!!)
            else -> CredentialLoadResult.Absent
        }

        override fun save(credential: String): CredentialSaveResult {
            saveCount += 1
            if (failedSavesRemaining > 0) {
                failedSavesRemaining -= 1
                return CredentialSaveResult.Failed
            }
            this.credential = credential
            return CredentialSaveResult.Saved
        }

        override fun clear(): CredentialClearResult {
            credential = null
            return CredentialClearResult.Cleared
        }
    }
}
