package com.fortymm.android.home

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.fortymm.android.session.NewGuestStatus
import com.fortymm.android.session.SessionEndCode
import com.fortymm.android.session.SessionState
import com.fortymm.android.ui.FortyMMSpace

@Composable
fun HomeShell(
    sessionState: SessionState,
    onRetry: () -> Unit,
    onStartNewGuest: () -> Unit = {},
) {
    Scaffold(contentWindowInsets = WindowInsets.safeDrawing) { contentPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding)
                .padding(horizontal = FortyMMSpace.S6.dp, vertical = FortyMMSpace.S4.dp),
        ) {
            Text(
                text = "FortyMM",
                modifier = Modifier.semantics { heading() },
                style = androidx.compose.material3.MaterialTheme.typography.displaySmall,
            )
            Text(
                text = "Home",
                modifier = Modifier.padding(top = FortyMMSpace.S8.dp),
                style = androidx.compose.material3.MaterialTheme.typography.titleLarge,
            )
            when (sessionState) {
                SessionState.Loading -> Text(
                    text = "Starting FortyMM…",
                    modifier = Modifier.padding(top = FortyMMSpace.S4.dp),
                )

                is SessionState.Ready -> Text(
                    text = sessionState.user.username,
                    modifier = Modifier.padding(top = FortyMMSpace.S4.dp),
                    style = androidx.compose.material3.MaterialTheme.typography.headlineSmall,
                )

                is SessionState.SessionEnded -> {
                    Text(
                        text = "Signed out",
                        modifier = Modifier.padding(top = FortyMMSpace.S4.dp),
                        style = MaterialTheme.typography.headlineSmall,
                        color = MaterialTheme.colorScheme.onBackground,
                    )
                    Text(
                        text = sessionEndedMessage(sessionState.reason.code),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    NewGuestRecovery(sessionState.newGuest, onStartNewGuest)
                }

                is SessionState.UnreadableStorage -> {
                    Text(
                        text = "We couldn't read your saved session.",
                        modifier = Modifier.padding(top = FortyMMSpace.S4.dp),
                    )
                    NewGuestRecovery(sessionState.newGuest, onStartNewGuest)
                }

                is SessionState.RetryableStartup -> {
                    Text(
                        text = sessionState.message,
                        modifier = Modifier.padding(top = FortyMMSpace.S4.dp),
                    )
                    Button(
                        onClick = onRetry,
                        modifier = Modifier.padding(top = FortyMMSpace.S4.dp),
                    ) {
                        Text("Retry")
                    }
                }
            }
        }
    }
}

private fun sessionEndedMessage(code: SessionEndCode): String = when (code) {
    SessionEndCode.Ended -> "You've been signed out."
    SessionEndCode.Merged -> "This guest was merged into an account."
    SessionEndCode.Expired -> "Your saved session has expired."
}

/** The one explicit way out of a recovery state. It never runs on its own. */
@Composable
private fun NewGuestRecovery(status: NewGuestStatus, onStartNewGuest: () -> Unit) {
    if (status == NewGuestStatus.Failed) {
        Text(
            text = "We couldn't start a new guest. Please try again.",
            modifier = Modifier
                .padding(top = FortyMMSpace.S4.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
            color = MaterialTheme.colorScheme.error,
        )
    }
    val starting = status == NewGuestStatus.Starting
    Button(
        onClick = onStartNewGuest,
        enabled = !starting,
        modifier = Modifier
            .padding(top = FortyMMSpace.S4.dp)
            .semantics { if (starting) stateDescription = "Starting a new guest" },
    ) {
        if (starting) {
            CircularProgressIndicator(
                modifier = Modifier
                    .padding(end = FortyMMSpace.S2.dp)
                    .size(16.dp)
                    .clearAndSetSemantics {},
                strokeWidth = 2.dp,
            )
        }
        Text("Continue as a new guest")
    }
}
