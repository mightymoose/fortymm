package com.fortymm.android

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import com.fortymm.android.network.FortyMMApiClient
import com.fortymm.android.session.AndroidSessionCredentialStore
import com.fortymm.android.session.SessionOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.HttpUrl.Companion.toHttpUrl

class FortyMMTestRunner : AndroidJUnitRunner() {
    override fun newApplication(
        classLoader: ClassLoader?,
        className: String?,
        context: Context?,
    ): Application = super.newApplication(
        classLoader,
        FortyMMTestApplication::class.java.name,
        context,
    )
}

class FortyMMTestApplication : Application(), SessionOwnerProvider {
    private val defaultSessionOwner by lazy {
        SessionOwner(
            apiClient = FortyMMApiClient(BuildConfig.API_BASE_URL.toHttpUrl()),
            credentialStore = AndroidSessionCredentialStore(applicationContext),
            applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )
    }

    override val sessionOwner: SessionOwner
        get() = SessionOwnerTestRegistry.sessionOwner ?: defaultSessionOwner
}

object SessionOwnerTestRegistry {
    @Volatile
    var sessionOwner: SessionOwner? = null
}
