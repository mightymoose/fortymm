package com.fortymm.android.session

import android.content.ContextWrapper
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
import java.security.KeyStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.SecretKey

@RunWith(AndroidJUnit4::class)
class AndroidSessionCredentialStoreTest {
    private val targetContext = InstrumentationRegistry.getInstrumentation().targetContext
    private val context = object : ContextWrapper(targetContext) {
        override fun getFilesDir(): File =
            File(targetContext.filesDir, "credential-store-tests").apply(File::mkdirs)

        override fun getPackageName(): String = "${targetContext.packageName}.credential-store-tests"
    }
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
        assertEquals(CredentialLoadResult.Credential(credential, Long.MAX_VALUE), reader.load())

        assertEquals(CredentialClearResult.Cleared, reader.clear())
        assertEquals(CredentialLoadResult.Absent, AndroidSessionCredentialStore(context).load())
    }

    @Test
    fun clearDeletesTheKeystoreAliasBeforeTheNextCredentialIsSaved() {
        val alias = "${context.packageName}.session-credential.v1"
        val store = AndroidSessionCredentialStore(context)
        assertEquals(CredentialSaveResult.Saved, store.save("credential-with-old-key"))
        assertTrue(androidKeyStore().containsAlias(alias))

        assertEquals(CredentialClearResult.Cleared, store.clear())

        assertFalse(androidKeyStore().containsAlias(alias))
        assertEquals(CredentialSaveResult.Saved, store.save("credential-with-fresh-key"))
        assertEquals(
            CredentialLoadResult.Credential("credential-with-fresh-key", Long.MAX_VALUE),
            AndroidSessionCredentialStore(context).load(),
        )
    }

    @Test
    fun sessionEndedReasonReplacesTheCredentialAndSurvivesANewStore() {
        val store = AndroidSessionCredentialStore(context)
        val reason = SessionEndReason(SessionEndCode.Merged, email = "player@example.com")

        assertEquals(CredentialSaveResult.Saved, store.save("merged-guest-credential"))
        assertEquals(CredentialSaveResult.Saved, store.markSessionEnded(reason))

        assertEquals(
            CredentialLoadResult.SessionEnded(reason),
            AndroidSessionCredentialStore(context).load(),
        )
    }

    @Test
    fun endedMarkerWrittenBeforeReasonCodesReadsAsSignedOut() {
        assertEquals(CredentialSaveResult.Saved, AndroidSessionCredentialStore(context).save("creates-the-key"))
        writeProtectedPayload(
            """{"kind":"session-ended","message":"You've been signed out. Sign in to continue.","email":null}""",
        )

        assertEquals(
            CredentialLoadResult.SessionEnded(SessionEndReason(SessionEndCode.Ended)),
            AndroidSessionCredentialStore(context).load(),
        )
    }

    @Test
    fun syncedTemporaryCredentialIsRecoveredAfterProcessDeathBeforeRename() {
        val credential = "credential-synced-before-process-death"
        val writer = AndroidSessionCredentialStore(context)
        assertEquals(CredentialSaveResult.Saved, writer.save(credential))
        val credentialFile = File(credentialDirectory, "credential.bin")
        val temporaryFile = File(credentialDirectory, "credential.bin.tmp")
        assertTrue(credentialFile.renameTo(temporaryFile))

        assertEquals(
            CredentialLoadResult.Credential(credential, Long.MAX_VALUE),
            AndroidSessionCredentialStore(context).load(),
        )
        assertTrue(credentialFile.exists())
        assertFalse(temporaryFile.exists())
    }

    @Test
    fun credentialCommitAndTemporaryPromotionSyncTheParentDirectory() {
        var saveSyncCount = 0
        val writer = AndroidSessionCredentialStore(context) { directory ->
            assertEquals(credentialDirectory, directory)
            saveSyncCount += 1
        }
        assertEquals(CredentialSaveResult.Saved, writer.save("directory-synced-credential"))
        assertEquals(1, saveSyncCount)
        val credentialFile = File(credentialDirectory, "credential.bin")
        val temporaryFile = File(credentialDirectory, "credential.bin.tmp")
        assertTrue(credentialFile.renameTo(temporaryFile))

        var recoverySyncCount = 0
        val reader = AndroidSessionCredentialStore(context) { directory ->
            assertEquals(credentialDirectory, directory)
            recoverySyncCount += 1
        }
        assertEquals(
            CredentialLoadResult.Credential("directory-synced-credential", Long.MAX_VALUE),
            reader.load(),
        )
        assertEquals(1, recoverySyncCount)
    }

    @Test
    fun syncedTemporarySessionEndReplacesAStalePrimaryAfterProcessDeathBeforeRename() {
        val store = AndroidSessionCredentialStore(context)
        val reason = SessionEndReason(SessionEndCode.Expired)
        assertEquals(CredentialSaveResult.Saved, store.save("stale-rejected-credential"))
        val credentialFile = File(credentialDirectory, "credential.bin")
        val stalePrimary = credentialFile.readBytes()
        assertEquals(CredentialSaveResult.Saved, store.markSessionEnded(reason))
        val temporaryFile = File(credentialDirectory, "credential.bin.tmp")
        assertTrue(credentialFile.renameTo(temporaryFile))
        credentialFile.writeBytes(stalePrimary)

        assertEquals(
            CredentialLoadResult.SessionEnded(reason),
            AndroidSessionCredentialStore(context).load(),
        )
        assertFalse(temporaryFile.exists())
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
    fun clearDeletesTheKeystoreAliasBeforeAFileDeletionFailure() {
        val alias = "${context.packageName}.session-credential.v1"
        val store = AndroidSessionCredentialStore(context)
        assertEquals(CredentialSaveResult.Saved, store.save("credential-with-invalidated-key"))
        val credentialFile = File(credentialDirectory, "credential.bin")
        assertTrue(credentialFile.delete())
        assertTrue(credentialFile.mkdirs())
        File(credentialFile, "blocks-directory-deletion").writeText("still present")

        assertEquals(CredentialClearResult.Failed, store.clear())

        assertFalse(androidKeyStore().containsAlias(alias))
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

    /** Writes [payload] in the store's on-disk format, as an older build would have. */
    private fun writeProtectedPayload(payload: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val key = androidKeyStore().getKey("${context.packageName}.session-credential.v1", null) as SecretKey
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val ciphertext = cipher.doFinal(payload.toByteArray(Charsets.UTF_8))
        File(credentialDirectory, "credential.bin").outputStream().use { output ->
            output.write(1)
            output.write(cipher.iv.size)
            output.write(cipher.iv)
            output.write(ciphertext)
        }
    }

    private fun androidKeyStore(): KeyStore =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

}
