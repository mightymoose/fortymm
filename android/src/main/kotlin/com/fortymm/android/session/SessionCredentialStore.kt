package com.fortymm.android.session

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The device-local vault for the opaque session credential.
 *
 * Callers can distinguish an absent credential from a vault that could not be
 * read or changed. They retain ownership of any in-memory retry policy.
 */
interface SessionCredentialStore {
    fun load(): CredentialLoadResult

    fun save(credential: String): CredentialSaveResult

    fun markSessionEnded(reason: SessionEndReason): CredentialSaveResult

    fun clear(): CredentialClearResult
}

sealed interface CredentialLoadResult {
    data class Credential(val value: String) : CredentialLoadResult

    data class SessionEnded(val reason: SessionEndReason) : CredentialLoadResult

    data object Absent : CredentialLoadResult

    data object UnreadableStorage : CredentialLoadResult
}

enum class CredentialSaveResult {
    Saved,
    Failed,
}

enum class CredentialClearResult {
    Cleared,
    Failed,
}

/** Android Keystore-backed implementation of [SessionCredentialStore]. */
class AndroidSessionCredentialStore(context: Context) : SessionCredentialStore {
    private val credentialFile = File(context.filesDir, CREDENTIAL_DIRECTORY).resolve(CREDENTIAL_FILE)
    private val temporaryCredentialFile = File(credentialFile.parentFile, "$CREDENTIAL_FILE.tmp")
    private val keyAlias = "${context.packageName}.session-credential.v1"
    private val json = Json { ignoreUnknownKeys = true }

    override fun load(): CredentialLoadResult = synchronized(processWideStorageLock) {
        try {
            val temporary = temporaryCredentialFile
                .takeIf(File::exists)
                ?.let(::readStoredSession)
            when {
                temporary != null && temporary != CredentialLoadResult.UnreadableStorage -> {
                    promoteTemporaryCredential()
                    temporary
                }
                credentialFile.exists() -> readStoredSession(credentialFile)
                temporary != null -> temporary
                else -> CredentialLoadResult.Absent
            }
        } catch (_: Exception) {
            CredentialLoadResult.UnreadableStorage
        }
    }

    override fun save(credential: String): CredentialSaveResult = synchronized(processWideStorageLock) {
        writeProtectedPayload(
            json.encodeToString(StoredSessionDto(kind = CREDENTIAL_KIND, credential = credential)),
        )
    }

    override fun markSessionEnded(reason: SessionEndReason): CredentialSaveResult =
        synchronized(processWideStorageLock) {
            writeProtectedPayload(
                json.encodeToString(
                    StoredSessionDto(
                        kind = SESSION_ENDED_KIND,
                        message = reason.message,
                        email = reason.email,
                    ),
                ),
            )
        }

    private fun writeProtectedPayload(payload: String): CredentialSaveResult {
        try {
            val encrypted = encrypt(payload.toByteArray(Charsets.UTF_8))
            writeCiphertext(encrypted.initializationVector, encrypted.ciphertext)
            return CredentialSaveResult.Saved
        } catch (_: Exception) {
            return CredentialSaveResult.Failed
        }
    }

    private fun decodeStoredSession(payload: String): CredentialLoadResult {
        val stored = try {
            json.decodeFromString<StoredSessionDto>(payload)
        } catch (_: Exception) {
            return CredentialLoadResult.Credential(payload)
        }
        return when (stored.kind) {
            CREDENTIAL_KIND -> stored.credential
                ?.let(CredentialLoadResult::Credential)
                ?: CredentialLoadResult.UnreadableStorage
            SESSION_ENDED_KIND -> CredentialLoadResult.SessionEnded(
                SessionEndReason(
                    message = stored.message ?: "Your session has ended. Sign in to continue.",
                    email = stored.email,
                ),
            )
            else -> CredentialLoadResult.UnreadableStorage
        }
    }

    private fun readStoredSession(file: File): CredentialLoadResult = try {
        val (initializationVector, ciphertext) = readCiphertext(file)
        val plaintext = decrypt(initializationVector, ciphertext).toString(Charsets.UTF_8)
        decodeStoredSession(plaintext)
    } catch (_: Exception) {
        CredentialLoadResult.UnreadableStorage
    }

    private fun promoteTemporaryCredential() {
        if (credentialFile.exists()) {
            check(credentialFile.delete()) { "Unable to replace stale session credential" }
        }
        check(temporaryCredentialFile.renameTo(credentialFile)) {
            "Unable to recover temporary session credential"
        }
    }

    override fun clear(): CredentialClearResult = synchronized(processWideStorageLock) {
        try {
            val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
            if (keyStore.containsAlias(keyAlias)) {
                keyStore.deleteEntry(keyAlias)
            }
            if (!deleteIfPresent(credentialFile) || !deleteIfPresent(temporaryCredentialFile)) {
                CredentialClearResult.Failed
            } else {
                CredentialClearResult.Cleared
            }
        } catch (_: Exception) {
            CredentialClearResult.Failed
        }
    }

    private fun encrypt(plaintext: ByteArray): EncryptedCredential {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        return EncryptedCredential(cipher.iv, cipher.doFinal(plaintext))
    }

    private fun decrypt(initializationVector: ByteArray, ciphertext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_LENGTH_BITS, initializationVector))
        return cipher.doFinal(ciphertext)
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun readCiphertext(file: File): EncryptedCredential =
        DataInputStream(BufferedInputStream(FileInputStream(file))).use { input ->
            val version = input.readUnsignedByte()
            require(version == FORMAT_VERSION) { "Unsupported credential format" }
            val ivLength = input.readUnsignedByte()
            require(ivLength in 12..32) { "Invalid credential initialization vector" }
            val initializationVector = ByteArray(ivLength)
            input.readFully(initializationVector)
            val ciphertext = input.readBytes()
            require(ciphertext.isNotEmpty()) { "Missing credential ciphertext" }
            EncryptedCredential(initializationVector, ciphertext)
        }

    private fun writeCiphertext(initializationVector: ByteArray, ciphertext: ByteArray) {
        credentialFile.parentFile?.mkdirs()
        FileOutputStream(temporaryCredentialFile).use { fileOutput ->
            DataOutputStream(fileOutput).apply {
                writeByte(FORMAT_VERSION)
                writeByte(initializationVector.size)
                write(initializationVector)
                write(ciphertext)
                flush()
            }
            fileOutput.fd.sync()
        }
        check(temporaryCredentialFile.renameTo(credentialFile)) { "Unable to save credential" }
    }

    private fun deleteIfPresent(file: File): Boolean = !file.exists() || file.delete()

    private data class EncryptedCredential(
        val initializationVector: ByteArray,
        val ciphertext: ByteArray,
    )

    private companion object {
        val processWideStorageLock = Any()
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_LENGTH_BITS = 128
        const val FORMAT_VERSION = 1
        const val CREDENTIAL_DIRECTORY = "session-credentials"
        const val CREDENTIAL_FILE = "credential.bin"
        const val CREDENTIAL_KIND = "credential"
        const val SESSION_ENDED_KIND = "session-ended"
    }
}

@Serializable
private data class StoredSessionDto(
    val kind: String,
    val credential: String? = null,
    val message: String? = null,
    val email: String? = null,
)
