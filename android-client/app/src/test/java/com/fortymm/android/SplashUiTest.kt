package com.fortymm.android

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import com.fortymm.android.pages.SplashScreen
import org.junit.Rule
import org.junit.Test
import java.io.File
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class SplashUiTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun showsTheWordmarkAsAHeading() {
        val splash = SplashScreen(rule)

        splash.wordmark.assertIsDisplayed()
        splash.wordmark.assert(isHeading())

        val screenshots = File(requireNotNull(System.getProperty("fortymm.screenshots"))).apply { mkdirs() }
        File(screenshots, "splash.png").outputStream().use {
            rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
