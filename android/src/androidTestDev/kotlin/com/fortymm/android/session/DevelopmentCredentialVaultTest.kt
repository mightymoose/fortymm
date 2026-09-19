package com.fortymm.android.session

import android.content.pm.ApplicationInfo
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test

class DevelopmentCredentialVaultTest {
    @Test
    fun developmentCredentialVaultIsPrivateToTheDevelopmentInstallationAndExcludedFromBackup() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        assertEquals("com.fortymm.android.dev", context.packageName)
        assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
    }
}
