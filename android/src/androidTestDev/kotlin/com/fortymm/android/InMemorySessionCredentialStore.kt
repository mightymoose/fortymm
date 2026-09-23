package com.fortymm.android

import com.fortymm.android.session.CredentialClearResult
import com.fortymm.android.session.CredentialLoadResult
import com.fortymm.android.session.CredentialSaveResult
import com.fortymm.android.session.SessionCredentialStore
import com.fortymm.android.session.SessionEndReason

internal class InMemorySessionCredentialStore(
    private var credential: String? = null,
    private var sessionEndReason: SessionEndReason? = null,
) : SessionCredentialStore {
    private var expiresAtEpochMillis: Long? = credential?.let { Long.MAX_VALUE }

    override fun load(): CredentialLoadResult = when {
        sessionEndReason != null -> CredentialLoadResult.SessionEnded(sessionEndReason!!)
        credential != null -> CredentialLoadResult.Credential(credential!!, expiresAtEpochMillis)
        else -> CredentialLoadResult.Absent
    }

    override fun save(credential: String, expiresAtEpochMillis: Long): CredentialSaveResult {
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
        sessionEndReason = null
        return CredentialClearResult.Cleared
    }
}
