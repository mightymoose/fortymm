package com.fortymm.android.session

import com.fortymm.android.network.FortyMMApiClient
import com.fortymm.android.network.SessionBootstrap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.util.UUID

data class SessionUser(
    val id: UUID,
    val username: String,
)

sealed interface SessionState {
    data object Loading : SessionState

    data class Ready(val user: SessionUser) : SessionState

    data class RetryableStartup(val message: String) : SessionState
}

/** Process-level owner of credential restoration and session bootstrap state. */
class SessionOwner(
    private val apiClient: FortyMMApiClient,
    private val credentialStore: SessionCredentialStore,
) {
    private val mutableState = MutableStateFlow<SessionState>(SessionState.Loading)
    private var pendingPersistence: SessionBootstrap? = null

    val state: StateFlow<SessionState> = mutableState.asStateFlow()

    suspend fun bootstrap() {
        if (mutableState.value is SessionState.Ready) return
        mutableState.value = SessionState.Loading

        pendingPersistence?.let { session ->
            persistPendingSession(session)
            return
        }

        val storedCredential = when (val loaded = withContext(Dispatchers.IO) { credentialStore.load() }) {
            is CredentialLoadResult.Credential -> loaded.value
            CredentialLoadResult.Absent -> null
            CredentialLoadResult.UnreadableStorage -> {
                mutableState.value = SessionState.RetryableStartup(
                    "We couldn't read your saved session. Please try again.",
                )
                return
            }
        }

        try {
            val session = apiClient.bootstrap(storedCredential)
            finishBootstrap(session, storedCredential)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            mutableState.value = SessionState.RetryableStartup(
                "We couldn't start FortyMM. Check your connection and try again.",
            )
        }
    }

    private suspend fun finishBootstrap(session: SessionBootstrap, storedCredential: String?) {
        if (session.credential != storedCredential) {
            pendingPersistence = session
            persistPendingSession(session)
            return
        }
        mutableState.value = SessionState.Ready(session.user)
    }

    private suspend fun persistPendingSession(session: SessionBootstrap) {
        val saved = withContext(Dispatchers.IO) {
            credentialStore.save(session.credential)
        }
        if (saved == CredentialSaveResult.Saved) {
            pendingPersistence = null
            mutableState.value = SessionState.Ready(session.user)
        } else {
            mutableState.value = SessionState.RetryableStartup(
                "We couldn't protect your session on this device. Please try again.",
            )
        }
    }
}
