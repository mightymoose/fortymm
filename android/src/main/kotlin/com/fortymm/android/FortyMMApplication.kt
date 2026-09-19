package com.fortymm.android

import android.app.Application
import com.fortymm.android.network.FortyMMApiClient
import com.fortymm.android.session.AndroidSessionCredentialStore
import com.fortymm.android.session.SessionOwner
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Process-wide composition root for Android services. */
class FortyMMApplication : Application() {
    private val httpClient by lazy { FortyMMApiClient.newHttpClient() }

    val sessionOwner: SessionOwner by lazy {
        SessionOwner(
            apiClient = FortyMMApiClient(
                baseUrl = BuildConfig.API_BASE_URL.toHttpUrl(),
                httpClient = httpClient,
            ),
            credentialStore = AndroidSessionCredentialStore(applicationContext),
        )
    }
}
