package com.fortymm.android.session

import com.fortymm.android.network.AuthenticatedResponse
import com.fortymm.android.network.FortyMMApiClient
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class SessionOwnerTest {
    private lateinit var server: MockWebServer
    private val responseGates = mutableListOf<HeldResponse>()

    @Before
    fun startServer() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stopServer() {
        responseGates.forEach(HeldResponse::release)
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
    fun overlappingBootstrapCallersObserveOneGuestIdentity() = runBlocking {
        val userId = UUID.fromString("196ea2c9-cd38-437c-85b1-2c050824bb85")
        val heldResponse = holdResponse(
            sessionResponse(userId, "shared-guest")
                .addHeader("Set-Cookie", "session=shared-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=shared-csrf; Path=/"),
        )
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = MemoryCredentialStore(),
        )

        val firstCaller = async(start = CoroutineStart.UNDISPATCHED) {
            owner.bootstrap()
            owner.state.value
        }
        heldResponse.awaitRequest()
        val secondCaller = async(start = CoroutineStart.UNDISPATCHED) {
            owner.bootstrap()
            owner.state.value
        }
        heldResponse.release()

        val expected = SessionState.Ready(SessionUser(userId, "shared-guest"))
        assertEquals(expected, firstCaller.await())
        assertEquals(expected, secondCaller.await())
        assertEquals(1, server.requestCount)
    }

    @Test
    fun cancellingOneBootstrapCallerLetsAnotherFinishAndLaterProcessRestoreTheGuest() = runBlocking {
        val userId = UUID.fromString("0b47aab8-7453-49ae-a359-b78cd77151c2")
        val credentialStore = MemoryCredentialStore()
        val firstResponse = holdResponse(
            sessionResponse(userId, "first-guest")
                .addHeader("Set-Cookie", "session=first-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=first-csrf; Path=/"),
        )
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )

        val firstUiCaller = launch(start = CoroutineStart.UNDISPATCHED) { owner.bootstrap() }
        firstResponse.awaitRequest()
        val remainingCaller = async(start = CoroutineStart.UNDISPATCHED) {
            owner.bootstrap()
            owner.state.value
        }
        firstUiCaller.cancelAndJoin()
        assertTrue(firstUiCaller.isCancelled)
        firstResponse.release()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "first-guest")),
            remainingCaller.await(),
        )
        assertEquals("first-session", credentialStore.credential)
        assertEquals(1, server.requestCount)

        val restoredResponse = holdResponse(
            sessionResponse(userId, "restored-guest")
                .addHeader("Set-Cookie", "csrf_token=restored-csrf; Path=/"),
        )
        val laterProcess = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )
        val restoredState = async(start = CoroutineStart.UNDISPATCHED) {
            laterProcess.bootstrap()
            laterProcess.state.value
        }
        restoredResponse.awaitRequest()
        restoredResponse.release()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "restored-guest")),
            restoredState.await(),
        )
        assertEquals(null, server.takeRequest().getHeader("Cookie"))
        assertEquals("session=first-session", server.takeRequest().getHeader("Cookie"))
        assertEquals(2, server.requestCount)
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
    fun endedMarkerSurvivesProcessDeathUntilTheNewGuestCredentialIsSaved() = runBlocking {
        val endedReason = SessionEndReason(message = "You've been signed out.", email = null)
        val credentialStore = MemoryCredentialStore().apply { sessionEndReason = endedReason }
        val userId = UUID.fromString("5d0b7a52-2a8b-4c55-9f0e-6c4a0f5e2b11")
        val newGuestResponse = holdResponse(
            sessionResponse(userId, "new-guest")
                .addHeader("Set-Cookie", "session=new-guest-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=new-guest-csrf; Path=/"),
        )
        val dyingProcess = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )
        dyingProcess.bootstrap()

        val recovery = async(start = CoroutineStart.UNDISPATCHED) { dyingProcess.startNewGuest() }
        newGuestResponse.awaitRequest()
        val relaunchedProcess = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )
        relaunchedProcess.bootstrap()

        assertEquals(
            SessionState.SessionEnded(endedReason.message, endedReason.email),
            relaunchedProcess.state.value,
        )
        assertEquals(1, server.requestCount)
        newGuestResponse.release()
        recovery.await()
        assertEquals("new-guest-session", credentialStore.credential)
        assertEquals(null, credentialStore.sessionEndReason)
    }

    @Test
    fun failedNewGuestStartStaysOnTheRecoveryScreenAndCanBeRetried() = runBlocking {
        val endedReason = SessionEndReason(message = "You've been signed out.", email = null)
        val credentialStore = MemoryCredentialStore().apply { sessionEndReason = endedReason }
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )
        owner.bootstrap()
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"detail":"unavailable"}"""))

        owner.startNewGuest()

        assertEquals(
            SessionState.SessionEnded(
                endedReason.message,
                endedReason.email,
                newGuest = NewGuestStatus.Failed,
            ),
            owner.state.value,
        )
        assertEquals(endedReason, credentialStore.sessionEndReason)

        val userId = UUID.fromString("e3c1c0f4-7a51-4c4e-8d51-0f7c2b9f6a10")
        server.enqueue(
            sessionResponse(userId, "retried-new-guest")
                .addHeader("Set-Cookie", "session=retried-new-guest-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=retried-new-guest-csrf; Path=/"),
        )
        owner.startNewGuest()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "retried-new-guest")),
            owner.state.value,
        )
        assertEquals(2, server.requestCount)
    }

    @Test
    fun doubleTappingContinueAsANewGuestCreatesOneNewIdentity() = runBlocking {
        val endedReason = SessionEndReason(message = "You've been signed out.", email = null)
        val credentialStore = MemoryCredentialStore().apply { sessionEndReason = endedReason }
        val userId = UUID.fromString("a4f7e0f2-58c4-4b0e-9d7e-3f8a2c1b6d55")
        val newGuestResponse = holdResponse(
            sessionResponse(userId, "only-new-guest")
                .addHeader("Set-Cookie", "session=only-new-guest-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=only-new-guest-csrf; Path=/"),
        )
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = credentialStore,
        )
        owner.bootstrap()

        val firstTap = async(start = CoroutineStart.UNDISPATCHED) { owner.startNewGuest() }
        newGuestResponse.awaitRequest()
        assertEquals(
            SessionState.SessionEnded(
                endedReason.message,
                endedReason.email,
                newGuest = NewGuestStatus.Starting,
            ),
            owner.state.value,
        )
        val secondTap = async(start = CoroutineStart.UNDISPATCHED) { owner.startNewGuest() }
        newGuestResponse.release()
        firstTap.await()
        secondTap.await()

        assertEquals(
            SessionState.Ready(SessionUser(userId, "only-new-guest")),
            owner.state.value,
        )
        assertEquals("only-new-guest-session", credentialStore.credential)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun structuredEndFromALaterRequestLeadsToRecoveryThatSurvivesRelaunch() = runBlocking {
        val userId = UUID.fromString("c2b8d1a7-6e0f-4f3b-9a51-2d7e4c8b0f16")
        val credentialStore = MemoryCredentialStore()
        server.enqueue(
            sessionResponse(userId, "soon-merged-guest")
                .addHeader("Set-Cookie", "session=merged-away-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=merged-away-csrf; Path=/"),
        )
        server.enqueue(
            sessionEndedResponse(
                code = "session_merged",
                message = "This guest session was merged into your account. Sign in to continue.",
                email = "owner@example.com",
            ),
        )
        val apiClient = FortyMMApiClient(server.url("/"))
        val owner = SessionOwner(apiClient, credentialStore)
        owner.bootstrap()

        val response = apiClient.get("/v1/me")

        val merged = SessionState.SessionEnded(
            "This guest session was merged into your account. Sign in to continue.",
            email = "owner@example.com",
        )
        assertEquals(AuthenticatedResponse.Obsolete, response)
        assertEquals(merged, owner.state.value)
        assertEquals(null, credentialStore.credential)
        val relaunchedProcess = SessionOwner(FortyMMApiClient(server.url("/")), credentialStore)
        relaunchedProcess.bootstrap()
        assertEquals(merged, relaunchedProcess.state.value)
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
    fun overlappingCallersShareOneFailedAttemptAndOneLaterRetry() = runBlocking {
        val userId = UUID.fromString("bc6fbf63-240c-470a-a05f-57335e2d3bd2")
        val (failedResponse, successfulResponse) = holdResponses(
            MockResponse()
                .setResponseCode(503)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"detail":"temporarily unavailable"}"""),
            sessionResponse(userId, "retried-guest")
                .addHeader("Set-Cookie", "session=retried-session; Path=/; HttpOnly")
                .addHeader("Set-Cookie", "csrf_token=retried-csrf; Path=/"),
        )
        val owner = SessionOwner(
            apiClient = FortyMMApiClient(server.url("/")),
            credentialStore = MemoryCredentialStore(),
        )

        val firstAttempt = async(start = CoroutineStart.UNDISPATCHED) {
            owner.bootstrap()
            owner.state.value
        }
        failedResponse.awaitRequest()
        val overlappingAttempt = async(start = CoroutineStart.UNDISPATCHED) {
            owner.bootstrap()
            owner.state.value
        }
        failedResponse.release()

        val retryableState = SessionState.RetryableStartup(
            "We couldn't start FortyMM. Check your connection and try again.",
        )
        assertEquals(retryableState, firstAttempt.await())
        assertEquals(retryableState, overlappingAttempt.await())
        assertEquals(1, server.requestCount)

        val firstRetry = async(start = CoroutineStart.UNDISPATCHED) {
            owner.bootstrap()
            owner.state.value
        }
        successfulResponse.awaitRequest()
        val overlappingRetry = async(start = CoroutineStart.UNDISPATCHED) {
            owner.bootstrap()
            owner.state.value
        }
        successfulResponse.release()

        val readyState = SessionState.Ready(SessionUser(userId, "retried-guest"))
        assertEquals(readyState, firstRetry.await())
        assertEquals(readyState, overlappingRetry.await())
        assertEquals(2, server.requestCount)
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

    private fun sessionEndedResponse(code: String, message: String, email: String? = null) =
        MockResponse()
            .setResponseCode(401)
            .setHeader("Content-Type", "application/json")
            .addHeader("Set-Cookie", "session=; Path=/; Max-Age=0; HttpOnly")
            .setBody(
                """{"detail":{"code":"$code","message":"$message"${email?.let { ""","email":"$it"""" } ?: ""}}}""",
            )

    private fun holdResponse(response: MockResponse): HeldResponse = holdResponses(response).single()

    private fun holdResponses(vararg responses: MockResponse): List<HeldResponse> {
        val heldResponses = responses.map(::HeldResponse)
        responseGates += heldResponses
        val pendingResponses = LinkedBlockingQueue(heldResponses)
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                val held = pendingResponses.poll()
                    ?: return MockResponse()
                        .setResponseCode(500)
                        .setBody("Unexpected extra session bootstrap request")
                held.requestReceived.countDown()
                held.responseReleased.await()
                return held.response
            }
        }
        return heldResponses
    }

    private class HeldResponse(val response: MockResponse) {
        val requestReceived = CountDownLatch(1)
        val responseReleased = CountDownLatch(1)

        fun awaitRequest() {
            check(requestReceived.await(5, TimeUnit.SECONDS)) {
                "Expected the session bootstrap request"
            }
        }

        fun release() {
            responseReleased.countDown()
        }
    }

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
