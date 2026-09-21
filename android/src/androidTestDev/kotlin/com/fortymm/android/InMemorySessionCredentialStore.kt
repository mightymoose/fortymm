package com.fortymm.android

import com.fortymm.android.session.CredentialClearResult
import com.fortymm.android.session.CredentialLoadResult
import com.fortymm.android.session.CredentialSaveResult
import com.fortymm.android.session.SessionCredentialStore
import com.fortymm.android.session.SessionEndReason

internal class InMemorySessionCredentialStore : SessionCredentialStore {
    private var credential: String? = null
    private var expiresAtEpochMillis: Long? = null

    override fun load(): CredentialLoadResult = credential
        ?.let { CredentialLoadResult.Credential(it, expiresAtEpochMillis) }
        ?: CredentialLoadResult.Absent

    override fun save(credential: String, expiresAtEpochMillis: Long): CredentialSaveResult {
        this.credential = credential
        this.expiresAtEpochMillis = expiresAtEpochMillis
        return CredentialSaveResult.Saved
    }

    override fun markSessionEnded(reason: SessionEndReason): CredentialSaveResult =
        CredentialSaveResult.Saved

    override fun clear(): CredentialClearResult {
        credential = null
        expiresAtEpochMillis = null
        return CredentialClearResult.Cleared
    }
}
