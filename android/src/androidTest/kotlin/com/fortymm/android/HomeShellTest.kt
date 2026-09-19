package com.fortymm.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test

class HomeShellTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun freshlyInstalledAppLaunchesToTheFortyMMHomeShell() {
        composeRule.onNodeWithText("FortyMM").assertIsDisplayed()
        composeRule.onNodeWithText("Home").assertIsDisplayed()
    }
}
