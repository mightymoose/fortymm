package com.fortymm.android

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.fortymm.android.home.HomeShell
import com.fortymm.android.session.NewGuestStatus
import com.fortymm.android.session.SessionEndCode
import com.fortymm.android.session.SessionEndReason
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
    fun sessionEndedShowsClientOwnedCopyAndOffersContinueAsANewGuest() {
        var startCount = 0
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(
                    SessionState.SessionEnded(SessionEndReason(SessionEndCode.Ended)),
                    onRetry = {},
                    onStartNewGuest = { startCount += 1 },
                )
            }
        }

        composeRule.onNodeWithText("Signed out").assertIsDisplayed()
        composeRule.onNodeWithText("You've been signed out.").assertIsDisplayed()
        composeRule.onAllNodesWithText("Sign in", substring = true).assertCountEquals(0)
        composeRule.onNodeWithText("Continue as a new guest").assertIsEnabled().performClick()
        composeRule.runOnIdle { assertEquals(1, startCount) }
    }

    @Test
    fun expiredSessionExplainsTheExpiry() {
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(SessionState.SessionEnded(SessionEndReason(SessionEndCode.Expired)), onRetry = {})
            }
        }

        composeRule.onNodeWithText("Your saved session has expired.").assertIsDisplayed()
    }

    @Test
    fun startingANewGuestDisablesTheButtonAndAnnouncesProgress() {
        var startCount = 0
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(
                    SessionState.SessionEnded(
                        SessionEndReason(SessionEndCode.Merged),
                        newGuest = NewGuestStatus.Starting,
                    ),
                    onRetry = {},
                    onStartNewGuest = { startCount += 1 },
                )
            }
        }

        composeRule.onNode(hasText("Continue as a new guest") and hasClickAction())
            .assertIsNotEnabled()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Starting a new guest"))
            .performClick()
        composeRule.runOnIdle { assertEquals(0, startCount) }
    }

    @Test
    fun failedNewGuestStartShowsARetryableError() {
        var startCount = 0
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(
                    SessionState.SessionEnded(
                        SessionEndReason(SessionEndCode.Ended),
                        newGuest = NewGuestStatus.Failed,
                    ),
                    onRetry = {},
                    onStartNewGuest = { startCount += 1 },
                )
            }
        }

        composeRule.onNodeWithText("We couldn't start a new guest. Please try again.").assertIsDisplayed()
        composeRule.onNodeWithText("Continue as a new guest").assertIsEnabled().performClick()
        composeRule.runOnIdle { assertEquals(1, startCount) }
    }

    @Test
    fun unreadableStorageOffersExplicitContinueAsANewGuest() {
        var startCount = 0
        composeRule.setContent {
            FortyMMTheme {
                HomeShell(
                    sessionState = SessionState.UnreadableStorage(),
                    onRetry = {},
                    onStartNewGuest = { startCount += 1 },
                )
            }
        }

        composeRule.onNodeWithText("We couldn't read your saved session.").assertIsDisplayed()
        composeRule.onNodeWithText("Continue as a new guest").performClick()
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
