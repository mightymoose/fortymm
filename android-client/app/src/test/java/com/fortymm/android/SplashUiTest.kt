package com.fortymm.android

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import com.fortymm.android.pages.SplashScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SplashUiTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun showsTheWordmarkAsAHeading() {
        val splash = SplashScreen(rule)

        splash.wordmark.assertIsDisplayed()
        splash.wordmark.assert(isHeading())
    }
}
