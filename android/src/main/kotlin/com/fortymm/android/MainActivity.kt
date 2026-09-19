package com.fortymm.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import com.fortymm.android.home.HomeShell
import com.fortymm.android.session.SessionOwner
import com.fortymm.android.ui.FortyMMTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sessionOwner = (application as FortyMMApplication).sessionOwner
        setContent { FortyMMApp(sessionOwner) }
    }
}

@Composable
fun FortyMMApp(sessionOwner: SessionOwner) {
    val sessionState by sessionOwner.state.collectAsState()
    val coroutineScope = rememberCoroutineScope()
    LaunchedEffect(sessionOwner) {
        sessionOwner.bootstrap()
    }

    FortyMMTheme {
        HomeShell(
            sessionState = sessionState,
            onRetry = { coroutineScope.launch { sessionOwner.bootstrap() } },
            onStartNewGuest = { coroutineScope.launch { sessionOwner.startNewGuest() } },
        )
    }
}
