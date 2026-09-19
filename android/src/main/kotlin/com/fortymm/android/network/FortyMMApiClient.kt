package com.fortymm.android.network

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
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false)
        .followSslRedirects(false)
        .build(),
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    private val apiRoot = baseUrl.newBuilder()
        .encodedPath("/")
        .query(null)
        .fragment(null)
        .build()
    private val sessionUrl = apiRoot.newBuilder().encodedPath(SESSION_PATH).build()

    internal var sessionCredential: String? = null
        private set

    internal var csrfToken: String? = null
        private set

    init {
        require(!httpClient.followRedirects && !httpClient.followSslRedirects) {
            "The session client must not follow redirects"
        }
    }

    suspend fun bootstrap(credential: String?): SessionBootstrap = withContext(Dispatchers.IO) {
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
            if (!response.isSuccessful) {
                throw IOException("Session bootstrap failed with HTTP ${response.code}")
            }
            val responseUrl = response.request.url
            if (
                responseUrl.scheme != apiRoot.scheme ||
                responseUrl.host != apiRoot.host ||
                responseUrl.port != apiRoot.port
            ) {
                throw IOException("Session bootstrap returned from an unexpected origin")
            }
            val body = response.body?.string() ?: throw IOException("Session bootstrap returned no body")
            val dto = try {
                json.decodeFromString<SessionResponseDto>(body)
            } catch (error: Exception) {
                throw IOException("Session bootstrap returned an unreadable response", error)
            }
            val cookies = response.headers.values("Set-Cookie")
                .mapNotNull { Cookie.parse(responseUrl, it) }
                .filter { it.matches(apiRoot) }
            val resolvedCredential = cookies
                .lastOrNull { it.name == SESSION_COOKIE_NAME && it.value.isNotEmpty() }
                ?.value
                ?: credential
                ?: throw IOException("Session bootstrap returned no session credential")
            val csrfToken = cookies
                .lastOrNull { it.name == CSRF_COOKIE_NAME && it.value.isNotEmpty() }
                ?.value
                ?: throw IOException("Session bootstrap returned no CSRF companion")
            val userId = try {
                UUID.fromString(dto.data.user.id)
            } catch (error: IllegalArgumentException) {
                throw IOException("Session bootstrap returned an invalid user id", error)
            }
            this@FortyMMApiClient.sessionCredential = resolvedCredential
            this@FortyMMApiClient.csrfToken = csrfToken
            SessionBootstrap(
                user = SessionUser(id = userId, username = dto.data.user.username),
                credential = resolvedCredential,
            )
        }
    }

    private companion object {
        const val SESSION_PATH = "/v1/session"
        const val SESSION_COOKIE_NAME = "session"
        const val CSRF_COOKIE_NAME = "csrf_token"
    }
}

data class SessionBootstrap(
    val user: SessionUser,
    val credential: String,
)

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
