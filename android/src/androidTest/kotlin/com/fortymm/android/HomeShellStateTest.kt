package com.fortymm.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.fortymm.android.home.HomeShell
import com.fortymm.android.session.SessionState
import com.fortymm.android.ui.FortyMMTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class HomeShellStateTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun homeShellRendersLoading() {
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(SessionState.Loading, onRetry = {})
            }
        }

        composeRule.onNodeWithText("Starting FortyMM…").assertIsDisplayed()
    }

    @Test
    fun sessionEndedShowsThePersistedReason() {
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(
                    SessionState.SessionEnded(
                        message = "You've been signed out. Sign in to continue.",
                        email = null,
                    ),
                    onRetry = {},
                )
            }
        }

        composeRule.onNodeWithText("Signed out").assertIsDisplayed()
        composeRule.onNodeWithText("You've been signed out. Sign in to continue.").assertIsDisplayed()
    }

    @Test
    fun unreadableStorageOffersExplicitStartNewGuestRecovery() {
        var startCount = 0
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(
                    sessionState = SessionState.UnreadableStorage(
                        "We couldn't read your saved session.",
                    ),
                    onRetry = {},
                    onStartNewGuest = { startCount += 1 },
                )
            }
        }

        composeRule.onNodeWithText("Start new guest").performClick()
        composeRule.runOnIdle { assertEquals(1, startCount) }
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
