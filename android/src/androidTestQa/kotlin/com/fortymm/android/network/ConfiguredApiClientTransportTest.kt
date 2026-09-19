package com.fortymm.android.network

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConfiguredApiClientTransportTest : LocalHttpTransportProbe() {
    @Test
    fun qaClientReachesTheControlledLocalHttpServer() {
        assertConfiguredClientReachesTheControlledLocalServer()
    }
}
