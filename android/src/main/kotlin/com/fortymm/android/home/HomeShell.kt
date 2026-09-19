package com.fortymm.android.home

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.fortymm.android.ui.FortyMMSpace

@Composable
fun HomeShell() {
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
        }
    }
}
