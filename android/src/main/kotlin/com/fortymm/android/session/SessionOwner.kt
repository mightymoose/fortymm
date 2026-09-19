package com.fortymm.android.session

import com.fortymm.android.network.FortyMMApiClient
import com.fortymm.android.network.EndedSession
import com.fortymm.android.network.IncompleteSession
import com.fortymm.android.network.SessionBootstrap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.util.UUID

data class SessionUser(
    val id: UUID,
    val username: String,
)

data class SessionEndReason(
    val message: String,
    val email: String?,
)

sealed interface SessionState {
    data object Loading : SessionState

    data class Ready(val user: SessionUser) : SessionState

    data class SessionEnded(val message: String, val email: String?) : SessionState

    data class UnreadableStorage(val message: String) : SessionState

    data class RetryableStartup(val message: String) : SessionState
}

/** Process-level owner of credential restoration and session bootstrap state. */
class SessionOwner(
    private val apiClient: FortyMMApiClient,
    private val credentialStore: SessionCredentialStore,
    private val applicationScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val mutableState = MutableStateFlow<SessionState>(SessionState.Loading)
    private val bootstrapLock = Any()
    private var bootstrapJob: Deferred<Unit>? = null
    private var pendingCredentialRecovery: String? = null
    private var pendingPersistence: SessionBootstrap? = null
    private var pendingSessionEnd: SessionEndReason? = null

    val state: StateFlow<SessionState> = mutableState.asStateFlow()

    suspend fun bootstrap() {
        if (mutableState.value is SessionState.Ready || mutableState.value is SessionState.SessionEnded) return
        val job = synchronized(bootstrapLock) {
            bootstrapJob?.takeIf { it.isActive }
                ?: applicationScope.async { bootstrapOnce() }
                    .also { bootstrapJob = it }
        }
        job.await()
    }

    suspend fun startNewGuest() {
        if (mutableState.value !is SessionState.UnreadableStorage) return
        val job = synchronized(bootstrapLock) {
            bootstrapJob?.takeIf { it.isActive }
                ?: applicationScope.async { resetUnreadableStorageAndBootstrap() }
                    .also { bootstrapJob = it }
        }
        job.await()
    }

    private suspend fun bootstrapOnce() {
        if (mutableState.value is SessionState.Ready || mutableState.value is SessionState.SessionEnded) return
        mutableState.value = SessionState.Loading

        pendingCredentialRecovery?.let { credential ->
            persistRecoveredCredential(credential)
            return
        }
        pendingSessionEnd?.let { reason ->
            persistSessionEnd(reason)
            return
        }
        pendingPersistence?.let { session ->
            persistPendingSession(session)
            return
        }

        val storedCredential = when (val loaded = withContext(Dispatchers.IO) { credentialStore.load() }) {
            is CredentialLoadResult.Credential -> loaded.value
            CredentialLoadResult.Absent -> null
            is CredentialLoadResult.SessionEnded -> {
                mutableState.value = SessionState.SessionEnded(
                    loaded.reason.message,
                    loaded.reason.email,
                )
                return
            }
            CredentialLoadResult.UnreadableStorage -> {
                mutableState.value = SessionState.UnreadableStorage(
                    "We couldn't read your saved session.",
                )
                return
            }
        }

        try {
            when (val result = apiClient.bootstrap(storedCredential)) {
                is SessionBootstrap -> finishBootstrap(result, storedCredential)
                is EndedSession -> {
                    pendingSessionEnd = result.reason
                    persistSessionEnd(result.reason)
                }
                is IncompleteSession -> {
                    pendingCredentialRecovery = result.credential
                    persistRecoveredCredential(result.credential)
                }
            }
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

    private suspend fun persistSessionEnd(reason: SessionEndReason) {
        val saved = withContext(Dispatchers.IO) {
            credentialStore.markSessionEnded(reason)
        }
        if (saved == CredentialSaveResult.Saved) {
            pendingSessionEnd = null
            pendingPersistence = null
            mutableState.value = SessionState.SessionEnded(reason.message, reason.email)
        } else {
            mutableState.value = SessionState.RetryableStartup(
                "We couldn't protect your signed-out state on this device. Please try again.",
            )
        }
    }

    private suspend fun persistRecoveredCredential(credential: String) {
        val saved = withContext(Dispatchers.IO) {
            credentialStore.save(credential)
        }
        if (saved == CredentialSaveResult.Saved) {
            pendingCredentialRecovery = null
            mutableState.value = SessionState.RetryableStartup(
                "We recovered your session. Please try again to finish loading it.",
            )
        } else {
            mutableState.value = SessionState.RetryableStartup(
                "We couldn't protect your session on this device. Please try again.",
            )
        }
    }

    private suspend fun resetUnreadableStorageAndBootstrap() {
        if (mutableState.value !is SessionState.UnreadableStorage) return
        val cleared = withContext(Dispatchers.IO) { credentialStore.clear() }
        if (cleared == CredentialClearResult.Failed) {
            mutableState.value = SessionState.UnreadableStorage(
                "We couldn't clear the unreadable saved session. Please try again.",
            )
            return
        }
        pendingCredentialRecovery = null
        pendingPersistence = null
        pendingSessionEnd = null
        bootstrapOnce()
    }
}
