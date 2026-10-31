package com.fortymm.android

import android.graphics.drawable.ColorDrawable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.core.content.res.ResourcesCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MainActivityTest {
    @Test
    fun windowBackgroundMatchesTheSplashBackground() {
        Robolectric.buildActivity(MainActivity::class.java).setup().use { controller ->
            val background = controller.get().window.decorView.background as ColorDrawable
            assertEquals(Color.bgApp.toArgb(), background.color)
        }
    }

    @Test
    fun wordmarkFontIsBundled() {
        Robolectric.buildActivity(MainActivity::class.java).setup().use { controller ->
            assertNotNull(ResourcesCompat.getFont(controller.get(), R.font.bebas_neue_regular))
        }
    }
}
