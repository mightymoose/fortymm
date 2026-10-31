package com.fortymm.android.pages

import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onNodeWithText

/** The splash screen, located by what TalkBack reads. */
class SplashScreen(private val rule: ComposeTestRule) {
    val wordmark: SemanticsNodeInteraction
        get() = rule.onNodeWithText("FortyMM")
}
