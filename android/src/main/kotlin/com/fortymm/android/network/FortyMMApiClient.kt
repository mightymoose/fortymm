package com.fortymm.android.network

import com.fortymm.android.session.SessionEndCode
import com.fortymm.android.session.SessionEndReason
import com.fortymm.android.session.SessionUser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.UUID

/** The one HTTP and JSON boundary used by Android features. */
class FortyMMApiClient(
    baseUrl: HttpUrl,
    private val httpClient: OkHttpClient = newHttpClient(),
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    private val apiRoot = baseUrl.newBuilder()
        .encodedPath("/")
        .query(null)
        .fragment(null)
        .build()
    private val sessionUrl = apiRoot.newBuilder().encodedPath(SESSION_PATH).build()

    private val credentialLock = Any()

    internal var sessionCredential: String? = null
        private set

    internal var csrfToken: String? = null
        private set

    /** Told when the current session ends. The request that saw the end waits for it. */
    internal var sessionEndListener: (suspend (SessionEndReason) -> Unit)? = null

    init {
        require(!httpClient.followRedirects && !httpClient.followSslRedirects) {
            "The session client must not follow redirects"
        }
    }

    suspend fun bootstrap(credential: String?): SessionBootstrapResult = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(sessionUrl)
            .header("Accept", "application/json")
            .apply {
                if (credential != null) {
                    header("Cookie", "$SESSION_COOKIE_NAME=$credential")
                }
            }
            .build()

        httpClient.newCall(request).execute().use { response ->
            val responseUrl = response.request.url
            if (
                responseUrl.scheme != apiRoot.scheme ||
                responseUrl.host != apiRoot.host ||
                responseUrl.port != apiRoot.port
            ) {
                throw IOException("Session bootstrap returned from an unexpected origin")
            }
            val cookies = response.headers.values("Set-Cookie")
                .mapNotNull { Cookie.parse(responseUrl, it) }
                .filter { it.matches(apiRoot) }
            val receivedSessionCookie = cookies
                .lastOrNull { it.name == SESSION_COOKIE_NAME && it.value.isNotEmpty() }
            val receivedCredential = receivedSessionCookie?.value
            val receivedCsrfToken = cookies
                .lastOrNull { it.name == CSRF_COOKIE_NAME && it.value.isNotEmpty() }
                ?.value
            val body = try {
                response.body?.string() ?: throw IOException("Session bootstrap returned no body")
            } catch (error: Exception) {
                if (response.isSuccessful) {
                    return@withContext incompleteSessionOrThrow(
                        receivedCredential = receivedCredential,
                        receivedCredentialExpiresAt = receivedSessionCookie?.expiresAt,
                        sentCredential = credential,
                        receivedCsrfToken = receivedCsrfToken,
                        message = "Session bootstrap response ended before its body was read",
                        cause = error,
                    )
                }
                throw IOException("Session bootstrap response ended before its error body was read", error)
            }
            if (!response.isSuccessful) {
                val endReason = credential?.let { sessionEndReason(response.code, body) }
                if (endReason != null) {
                    synchronized(credentialLock) {
                        this@FortyMMApiClient.sessionCredential = null
                        this@FortyMMApiClient.csrfToken = null
                    }
                    return@withContext EndedSession(endReason)
                }
                throw IOException("Session bootstrap failed with HTTP ${response.code}")
            }
            val dto = try {
                json.decodeFromString<SessionResponseDto>(body)
            } catch (error: Exception) {
                return@withContext incompleteSessionOrThrow(
                    receivedCredential = receivedCredential,
                    receivedCredentialExpiresAt = receivedSessionCookie?.expiresAt,
                    sentCredential = credential,
                    receivedCsrfToken = receivedCsrfToken,
                    message = "Session bootstrap returned an unreadable response",
                    cause = error,
                )
            }
            val resolvedCredential = receivedCredential
                ?: credential
                ?: throw IOException("Session bootstrap returned no session credential")
            val csrfToken = receivedCsrfToken
                ?: return@withContext incompleteSessionOrThrow(
                    receivedCredential = receivedCredential,
                    receivedCredentialExpiresAt = receivedSessionCookie?.expiresAt,
                    sentCredential = credential,
                    receivedCsrfToken = null,
                    message = "Session bootstrap returned no CSRF companion",
                )
            val userId = try {
                UUID.fromString(dto.data.user.id)
            } catch (error: IllegalArgumentException) {
                return@withContext incompleteSessionOrThrow(
                    receivedCredential = receivedCredential,
                    receivedCredentialExpiresAt = receivedSessionCookie?.expiresAt,
                    sentCredential = credential,
                    receivedCsrfToken = receivedCsrfToken,
                    message = "Session bootstrap returned an invalid user id",
                    cause = error,
                )
            }
            synchronized(credentialLock) {
                this@FortyMMApiClient.sessionCredential = resolvedCredential
                this@FortyMMApiClient.csrfToken = csrfToken
            }
            SessionBootstrap(
                user = SessionUser(id = userId, username = dto.data.user.username),
                credential = resolvedCredential,
                expiresAtEpochMillis = receivedSessionCookie?.expiresAt,
            )
        }
    }

    /**
     * Sends an authenticated GET for the current session.
     *
     * The response belongs to the credential that sent it. If that credential is no
     * longer current when the response arrives, the response is [AuthenticatedResponse.Obsolete]:
     * a late success cannot overwrite the new identity, and a late end cannot revoke it.
     */
    suspend fun get(path: String): AuthenticatedResponse {
        val sentCredential = synchronized(credentialLock) { sessionCredential }
            ?: throw IOException("There is no current session")
        val request = Request.Builder()
            .url(apiRoot.newBuilder().encodedPath(path).build())
            .header("Accept", "application/json")
            .header("Cookie", "$SESSION_COOKIE_NAME=$sentCredential")
            .build()
        val (code, body) = withContext(Dispatchers.IO) {
            httpClient.newCall(request).execute().use { response ->
                response.code to response.body?.string().orEmpty()
            }
        }
        val endReason = sessionEndReason(code, body)
        if (endReason != null) {
            if (endIfCurrent(sentCredential)) sessionEndListener?.invoke(endReason)
            return AuthenticatedResponse.Obsolete
        }
        if (synchronized(credentialLock) { sessionCredential != sentCredential }) {
            return AuthenticatedResponse.Obsolete
        }
        if (code !in 200..299) throw IOException("GET $path failed with HTTP $code")
        return AuthenticatedResponse.Current(body)
    }

    /** The one decoder for the API's structured session-ended responses. */
    private fun sessionEndReason(code: Int, body: String): SessionEndReason? {
        if (code != 401) return null
        val detail = try {
            json.decodeFromString<SessionEndedResponseDto>(body).detail
        } catch (_: Exception) {
            return null
        }
        val endCode = when (detail.code) {
            SessionEndCode.Ended.wireValue -> SessionEndCode.Ended
            SessionEndCode.Merged.wireValue -> SessionEndCode.Merged
            else -> return null
        }
        return SessionEndReason(endCode, detail.email)
    }

    private fun endIfCurrent(sentCredential: String): Boolean = synchronized(credentialLock) {
        if (sessionCredential != sentCredential) return false
        sessionCredential = null
        csrfToken = null
        true
    }

    private fun incompleteSessionOrThrow(
        receivedCredential: String?,
        receivedCredentialExpiresAt: Long?,
        sentCredential: String?,
        receivedCsrfToken: String?,
        message: String,
        cause: Exception? = null,
    ): IncompleteSession {
        if (receivedCredential != null && receivedCredential != sentCredential) {
            synchronized(credentialLock) {
                sessionCredential = receivedCredential
                csrfToken = receivedCsrfToken
            }
            return IncompleteSession(
                credential = receivedCredential,
                expiresAtEpochMillis = requireNotNull(receivedCredentialExpiresAt),
            )
        }
        throw IOException(message, cause)
    }

    companion object {
        private const val SESSION_PATH = "/v1/session"
        private const val SESSION_COOKIE_NAME = "session"
        private const val CSRF_COOKIE_NAME = "csrf_token"

        internal fun newHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .cookieJar(CookieJar.NO_COOKIES)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }
}

/** The outcome of an authenticated request, tied to the session that sent it. */
sealed interface AuthenticatedResponse {
    data class Current(val body: String) : AuthenticatedResponse

    /** The session that sent the request has ended or been replaced. Discard the response. */
    data object Obsolete : AuthenticatedResponse
}

sealed interface SessionBootstrapResult

data class SessionBootstrap(
    val user: SessionUser,
    val credential: String,
    val expiresAtEpochMillis: Long?,
) : SessionBootstrapResult

data class EndedSession(
    val reason: SessionEndReason,
) : SessionBootstrapResult

data class IncompleteSession(
    val credential: String,
    val expiresAtEpochMillis: Long,
) : SessionBootstrapResult

@Serializable
private data class SessionResponseDto(
    val data: SessionDataDto,
)

@Serializable
private data class SessionDataDto(
    val user: SessionUserDto,
)

@Serializable
private data class SessionUserDto(
    val id: String,
    val username: String,
)

@Serializable
private data class SessionEndedResponseDto(
    val detail: SessionEndedDetailDto,
)

@Serializable
private data class SessionEndedDetailDto(
    val code: String,
    val email: String? = null,
)
