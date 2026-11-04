package com.fortymm.android

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class DesignTokenTest(private val token: DesignToken) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun tokens() = DesignToken.entries.toList()

        // Gradle passes the checkout's file, so the test reads the reference itself.
        private val reference = File(requireNotNull(System.getProperty("fortymm.colorsAndType")))
    }

    @Test
    fun matchesTheReference() {
        val pattern = Regex("--${token.cssName}:\\s*#([0-9A-Fa-f]{6});")
        val match = pattern.find(reference.readText())
        assertNotNull("--${token.cssName} isn't in $reference", match)
        assertEquals(0xFF000000 or match!!.groupValues[1].toLong(16), token.argb)
    }
}
