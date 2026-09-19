package com.fortymm.android

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.fortymm.android.home.HomeShell
import com.fortymm.android.session.SessionState
import com.fortymm.android.session.SessionUser
import com.fortymm.android.ui.FortyMMTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class HomeShellStateTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun homeShellRendersLoadingThenTheApiReturnedUsername() {
        val user = SessionUser(
            id = UUID.fromString("2600f567-bc78-4701-884b-6b4f1fd24244"),
            username = "api-returned-guest",
        )
        var state: SessionState by mutableStateOf(SessionState.Loading)
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(state, onRetry = {})
            }
        }

        composeRule.onNodeWithText("Starting FortyMM…").assertIsDisplayed()
        composeRule.runOnIdle { state = SessionState.Ready(user) }
        composeRule.onNodeWithText("api-returned-guest").assertIsDisplayed()
    }

    @Test
    fun retryableStartupShowsItsMessageAndRequestsRetry() {
        var retryCount = 0
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(
                    SessionState.RetryableStartup("Protected storage is unavailable."),
                    onRetry = { retryCount += 1 },
                )
            }
        }

        composeRule.onNodeWithText("Protected storage is unavailable.").assertIsDisplayed()
        composeRule.onNodeWithText("Retry").performClick()
        composeRule.runOnIdle { assertEquals(1, retryCount) }
    }
}
