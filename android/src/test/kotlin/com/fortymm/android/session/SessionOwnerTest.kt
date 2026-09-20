package com.fortymm.android.session

import com.fortymm.android.network.FortyMMApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.util.UUID
import java.util.concurrent.TimeUnit

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
    fun expiredCookieIsPersistedAsSessionEndedWithoutSendingTheStaleCredential() = runBlocking {
        val userId = UUID.fromString("278658cc-d50d-455a-beb1-fe189668c141")
        val credentialStore = MemoryCredentialStore()
        server.enqueue(
            sessionResponse(userId, "expiring-guest")
                .addHeader("Set-Cookie", "session=expiring-session; Max-Age=2592000; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=expiring-csrf; Max-Age=2592000; Path=/"),
        )
        SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        ).bootstrap()
        val expiresAt = requireNotNull(credentialStore.expiresAtEpochMillis)

        val laterProcess = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
            currentTimeMillis = { expiresAt + 1 },
        )
        laterProcess.bootstrap()

        assertEquals(
            SessionState.SessionEnded(
                "Your saved session has expired. Start a new guest to continue.",
                email = null,
            ),
            laterProcess.state.value,
        )
        assertEquals(1, server.requestCount)
    }

    @Test
    fun cancelledUiCallerDoesNotRestartGuestCreation() = runBlocking {
        val firstUserId = UUID.fromString("0b47aab8-7453-49ae-a359-b78cd77151c2")
        val replacementUserId = UUID.fromString("693f6573-cae1-49cc-9d4d-f1dbc7c652a6")
        val credentialStore = MemoryCredentialStore()
        server.enqueue(
            sessionResponse(firstUserId, "first-guest")
                .addHeader("Set-Cookie", "session=first-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=first-csrf; Path=/")
                .setBodyDelay(300, TimeUnit.MILLISECONDS),
        )
        server.enqueue(
            sessionResponse(replacementUserId, "replacement-guest")
                .addHeader("Set-Cookie", "session=replacement-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=replacement-csrf; Path=/"),
        )
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )

        val firstUiCaller = launch { owner.bootstrap() }
        withContext(Dispatchers.IO) { server.takeRequest() }
        firstUiCaller.cancelAndJoin()
        owner.bootstrap()

        assertEquals(
            SessionState.Ready(SessionUser(firstUserId, "first-guest")),
            owner.state.value,
        )
        assertEquals("first-session", credentialStore.credential)
        assertEquals(1, server.requestCount)
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
    fun endedSessionPersistsAcrossLaterProcessWithoutMintingAReplacementGuest() = runBlocking {
        val credentialStore = MemoryCredentialStore().apply {
            credential = "revoked-session-token"
        }
        server.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setHeader("Content-Type", "application/json")
                .addHeader("Set-Cookie", "session=; Path=/; Max-Age=0; HttpOnly")
                .setBody(
                    """
                    {
                      "detail": {
                        "code": "session_ended",
                        "message": "You've been signed out. Sign in to continue."
                      }
                    }
                    """.trimIndent(),
                ),
        )
        val firstProcess = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )

        firstProcess.bootstrap()

        assertEquals(
            SessionState.SessionEnded("You've been signed out. Sign in to continue.", email = null),
            firstProcess.state.value,
        )
        val laterProcess = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )
        laterProcess.bootstrap()
        assertEquals(
            SessionState.SessionEnded("You've been signed out. Sign in to continue.", email = null),
            laterProcess.state.value,
        )
        assertEquals(1, server.requestCount)

        val replacementUserId = UUID.fromString("952dff7f-9bf5-42fa-a2cb-8d0e28ac6c04")
        server.enqueue(
            sessionResponse(replacementUserId, "replacement-guest")
                .addHeader("Set-Cookie", "session=replacement-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=replacement-csrf; Path=/"),
        )
        laterProcess.startNewGuest()

        assertEquals(
            SessionState.Ready(SessionUser(replacementUserId, "replacement-guest")),
            laterProcess.state.value,
        )
        assertEquals(2, server.requestCount)
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
    fun truncatedFreshGuestResponsePreservesItsCredentialForAuthenticatedRetry() = runBlocking {
        val userId = UUID.fromString("32a3e549-8868-459a-b309-d1905e5cb895")
        val credentialStore = MemoryCredentialStore()
        server.enqueue(
            sessionResponse(userId, "first-guest")
                .addHeader("Set-Cookie", "session=header-session-token; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=header-csrf; Path=/")
                .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
        )
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )

        owner.bootstrap()

        assertEquals("header-session-token", credentialStore.credential)
        server.enqueue(
            sessionResponse(userId, "recovered-guest")
                .addHeader("Set-Cookie", "csrf_token=recovered-csrf; Path=/"),
        )
        owner.bootstrap()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "recovered-guest")),
            owner.state.value,
        )
        assertEquals(null, server.takeRequest().getHeader("Cookie"))
        assertEquals("session=header-session-token", server.takeRequest().getHeader("Cookie"))
    }

    @Test
    fun unreadableCredentialStorageRequiresExplicitResetBeforeNewGuest() = runBlocking {
        val credentialStore = MemoryCredentialStore(unreadable = true)
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )

        owner.bootstrap()

        assertEquals(
            SessionState.UnreadableStorage(
                "We couldn't read your saved session.",
            ),
            owner.state.value,
        )
        assertEquals(0, server.requestCount)

        val userId = UUID.fromString("33ed6bd5-0a2f-4b99-81a2-6fd39db4c898")
        server.enqueue(
            sessionResponse(userId, "reset-guest")
                .addHeader("Set-Cookie", "session=reset-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=reset-csrf; Path=/"),
        )
        owner.startNewGuest()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "reset-guest")),
            owner.state.value,
        )
        assertEquals(1, server.requestCount)
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
            assertEquals(0, otherOrigin.requestCount)
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
        var expiresAtEpochMillis: Long? = Long.MAX_VALUE
        var sessionEndReason: SessionEndReason? = null
        var saveCount = 0

        override fun load(): CredentialLoadResult = when {
            unreadable -> CredentialLoadResult.UnreadableStorage
            sessionEndReason != null -> CredentialLoadResult.SessionEnded(sessionEndReason!!)
            credential != null -> CredentialLoadResult.Credential(credential!!, expiresAtEpochMillis)
            else -> CredentialLoadResult.Absent
        }

        override fun save(credential: String, expiresAtEpochMillis: Long): CredentialSaveResult {
            saveCount += 1
            if (failedSavesRemaining > 0) {
                failedSavesRemaining -= 1
                return CredentialSaveResult.Failed
            }
            this.credential = credential
            this.expiresAtEpochMillis = expiresAtEpochMillis
            sessionEndReason = null
            return CredentialSaveResult.Saved
        }

        override fun markSessionEnded(reason: SessionEndReason): CredentialSaveResult {
            credential = null
            expiresAtEpochMillis = null
            sessionEndReason = reason
            return CredentialSaveResult.Saved
        }

        override fun clear(): CredentialClearResult {
            credential = null
            expiresAtEpochMillis = null
            unreadable = false
            sessionEndReason = null
            return CredentialClearResult.Cleared
        }
    }
}
