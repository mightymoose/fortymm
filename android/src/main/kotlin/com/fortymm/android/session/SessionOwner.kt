package com.fortymm.android.session

import com.fortymm.android.network.FortyMMApiClient
import com.fortymm.android.network.EndedSession
import com.fortymm.android.network.IncompleteSession
import com.fortymm.android.network.SessionBootstrap
import com.fortymm.android.network.SessionBootstrapResult
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

/** Why a session ended. The recovery screen owns the copy for each code. */
enum class SessionEndCode(val wireValue: String) {
    Ended("session_ended"),
    Merged("session_merged"),
    Expired("session_expired"),
}

data class SessionEndReason(
    val code: SessionEndCode,
    /** The merged account's email. Kept for sign-in (#1729), never shown here. */
    val email: String? = null,
)

sealed interface SessionState {
    data object Loading : SessionState

    data class Ready(val user: SessionUser) : SessionState

    data class SessionEnded(
        val reason: SessionEndReason,
        val newGuest: NewGuestStatus = NewGuestStatus.Idle,
    ) : SessionState

    data class UnreadableStorage(
        val newGuest: NewGuestStatus = NewGuestStatus.Idle,
    ) : SessionState

    data class RetryableStartup(val message: String) : SessionState
}

/** Progress of an explicit "Continue as a new guest" request from a recovery state. */
enum class NewGuestStatus {
    Idle,
    Starting,
    Failed,
}

/** Process-level owner of credential restoration and session bootstrap state. */
class SessionOwner(
    private val apiClient: FortyMMApiClient,
    private val credentialStore: SessionCredentialStore,
    private val applicationScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    private val currentTimeMillis: () -> Long = System::currentTimeMillis,
) {
    private val mutableState = MutableStateFlow<SessionState>(SessionState.Loading)
    private val bootstrapLock = Any()
    private var bootstrapJob: Deferred<Unit>? = null
    private var pendingCredentialRecovery: IncompleteSession? = null
    private var pendingPersistence: SessionBootstrap? = null
    private var pendingSessionEnd: SessionEndReason? = null

    val state: StateFlow<SessionState> = mutableState.asStateFlow()

    init {
        apiClient.sessionEndListener = ::endSessionFromServer
    }

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
        if (!canStartNewGuest()) return
        val job = synchronized(bootstrapLock) {
            bootstrapJob?.takeIf { it.isActive }
                ?: applicationScope.async { startNewGuestOnce() }
                    .also { bootstrapJob = it }
        }
        job.await()
    }

    /** Persists a server-reported end of the current session and drops its unsaved work. */
    private suspend fun endSessionFromServer(reason: SessionEndReason) {
        val job = synchronized(bootstrapLock) {
            val previousJob = bootstrapJob
            applicationScope.async {
                previousJob?.join()
                pendingCredentialRecovery = null
                pendingPersistence = null
                pendingSessionEnd = reason
                persistSessionEnd(reason)
            }.also { bootstrapJob = it }
        }
        job.await()
    }

    private suspend fun bootstrapOnce() {
        if (mutableState.value is SessionState.Ready || mutableState.value is SessionState.SessionEnded) return
        mutableState.value = SessionState.Loading

        pendingCredentialRecovery?.let { session ->
            persistRecoveredCredential(session)
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
            is CredentialLoadResult.Credential -> {
                if (loaded.expiresAtEpochMillis == null || loaded.expiresAtEpochMillis <= currentTimeMillis()) {
                    val reason = SessionEndReason(SessionEndCode.Expired)
                    pendingSessionEnd = reason
                    persistSessionEnd(reason)
                    return
                }
                loaded
            }
            CredentialLoadResult.Absent -> null
            is CredentialLoadResult.SessionEnded -> {
                mutableState.value = SessionState.SessionEnded(loaded.reason)
                return
            }
            CredentialLoadResult.UnreadableStorage -> {
                mutableState.value = SessionState.UnreadableStorage()
                return
            }
        }

        requestSession(storedCredential)
    }

    private suspend fun requestSession(storedCredential: CredentialLoadResult.Credential?) {
        val result = try {
            apiClient.bootstrap(storedCredential?.value)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            mutableState.value = SessionState.RetryableStartup(
                "We couldn't start FortyMM. Check your connection and try again.",
            )
            return
        }
        applyBootstrapResult(result, storedCredential)
    }

    private suspend fun applyBootstrapResult(
        result: SessionBootstrapResult,
        storedCredential: CredentialLoadResult.Credential?,
    ) {
        when (result) {
            is SessionBootstrap -> finishBootstrap(result, storedCredential)
            is EndedSession -> {
                pendingSessionEnd = result.reason
                persistSessionEnd(result.reason)
            }
            is IncompleteSession -> {
                pendingCredentialRecovery = result
                persistRecoveredCredential(result)
            }
        }
    }

    private suspend fun finishBootstrap(
        session: SessionBootstrap,
        storedCredential: CredentialLoadResult.Credential?,
    ) {
        val resolvedSession = session.copy(
            expiresAtEpochMillis = session.expiresAtEpochMillis ?: storedCredential?.expiresAtEpochMillis,
        )
        if (
            resolvedSession.credential != storedCredential?.value ||
            session.expiresAtEpochMillis != null
        ) {
            pendingPersistence = resolvedSession
            persistPendingSession(resolvedSession)
            return
        }
        mutableState.value = SessionState.Ready(session.user)
    }

    private suspend fun persistPendingSession(session: SessionBootstrap) {
        val saved = withContext(Dispatchers.IO) {
            credentialStore.save(
                credential = session.credential,
                expiresAtEpochMillis = requireNotNull(session.expiresAtEpochMillis),
            )
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
            mutableState.value = SessionState.SessionEnded(reason)
        } else {
            mutableState.value = SessionState.RetryableStartup(
                "We couldn't protect your signed-out state on this device. Please try again.",
            )
        }
    }

    private suspend fun persistRecoveredCredential(session: IncompleteSession) {
        val saved = withContext(Dispatchers.IO) {
            credentialStore.save(session.credential, session.expiresAtEpochMillis)
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

    private fun canStartNewGuest(): Boolean =
        mutableState.value is SessionState.UnreadableStorage ||
            mutableState.value is SessionState.SessionEnded

    private suspend fun startNewGuestOnce() {
        val recoveryState = mutableState.value
        if (!canStartNewGuest()) return
        mutableState.value = recoveryState.withNewGuest(NewGuestStatus.Starting)
        if (recoveryState is SessionState.UnreadableStorage) {
            val cleared = withContext(Dispatchers.IO) { credentialStore.clear() }
            if (cleared == CredentialClearResult.Failed) {
                mutableState.value = recoveryState.withNewGuest(NewGuestStatus.Failed)
                return
            }
        }
        pendingCredentialRecovery = null
        pendingPersistence = null
        pendingSessionEnd = null
        // The ended marker stays stored until the new credential replaces it, so a
        // process death before that save relaunches into recovery, not a silent guest.
        val result = try {
            apiClient.bootstrap(credential = null)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            mutableState.value = recoveryState.withNewGuest(NewGuestStatus.Failed)
            return
        }
        applyBootstrapResult(result, storedCredential = null)
    }

    private fun SessionState.withNewGuest(status: NewGuestStatus): SessionState = when (this) {
        is SessionState.SessionEnded -> copy(newGuest = status)
        is SessionState.UnreadableStorage -> copy(newGuest = status)
        else -> this
    }
}
