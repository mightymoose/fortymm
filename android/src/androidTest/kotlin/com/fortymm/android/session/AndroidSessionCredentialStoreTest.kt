package com.fortymm.android.session

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class AndroidSessionCredentialStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val credentialDirectory = File(context.filesDir, "session-credentials")

    @Before
    @After
    fun removeTestCredentials() {
        credentialDirectory.deleteRecursively()
    }

    @Test
    fun savedCredentialSurvivesANewStoreThenIsAbsentAfterClear() {
        val credential = "session-credential-from-the-server"
        val writer = AndroidSessionCredentialStore(context)
        writer.clear()

        assertEquals(CredentialSaveResult.Saved, writer.save(credential))
        assertFalse(File(credentialDirectory, "credential.bin").readText().contains(credential))

        val reader = AndroidSessionCredentialStore(context)
        assertEquals(CredentialLoadResult.Credential(credential), reader.load())

        assertEquals(CredentialClearResult.Cleared, reader.clear())
        assertEquals(CredentialLoadResult.Absent, AndroidSessionCredentialStore(context).load())
    }

    @Test
    fun sessionEndedReasonReplacesTheCredentialAndSurvivesANewStore() {
        val store = AndroidSessionCredentialStore(context)
        val reason = SessionEndReason(
            message = "This guest session was merged into your account. Sign in to continue.",
            email = "player@example.com",
        )

        assertEquals(CredentialSaveResult.Saved, store.save("merged-guest-credential"))
        assertEquals(CredentialSaveResult.Saved, store.markSessionEnded(reason))

        assertEquals(
            CredentialLoadResult.SessionEnded(reason),
            AndroidSessionCredentialStore(context).load(),
        )
    }

    @Test
    fun unreadableStorageAndAFailedWriteAreNotReportedAsAnEmptyStore() {
        val credentialFile = File(credentialDirectory, "credential.bin")
        credentialFile.parentFile?.mkdirs()
        credentialFile.writeBytes(byteArrayOf(1, 12))

        assertEquals(CredentialLoadResult.UnreadableStorage, AndroidSessionCredentialStore(context).load())

        credentialDirectory.deleteRecursively()
        credentialDirectory.mkdirs()
        credentialFile.mkdirs()
        assertEquals(CredentialSaveResult.Failed, AndroidSessionCredentialStore(context).save("credential"))
        assertEquals(CredentialClearResult.Cleared, AndroidSessionCredentialStore(context).clear())
    }

    @Test
    fun simultaneousSavesFromSeparateStoresLeaveAnIntactCredential() {
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val first = executor.submit<CredentialSaveResult> {
                start.await()
                AndroidSessionCredentialStore(context).save("first-credential")
            }
            val second = executor.submit<CredentialSaveResult> {
                start.await()
                AndroidSessionCredentialStore(context).save("second-credential")
            }

            start.countDown()

            assertEquals(CredentialSaveResult.Saved, first.get(10, TimeUnit.SECONDS))
            assertEquals(CredentialSaveResult.Saved, second.get(10, TimeUnit.SECONDS))
            val loaded = AndroidSessionCredentialStore(context).load()
            assertTrue(
                loaded is CredentialLoadResult.Credential &&
                    loaded.value in setOf("first-credential", "second-credential"),
            )
        } finally {
            executor.shutdownNow()
        }
    }

}
