package com.fortymm.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * The wordmark on the app background, as the web client's loading screen
 * shows it. Nothing moves, because the design system's motion is feedback
 * only.
 */
@Composable
fun SplashScreen() {
    Box(
        modifier = Modifier.fillMaxSize().background(Color.bgApp),
        contentAlignment = Alignment.Center,
    ) {
        BasicText(
            text = "FortyMM",
            modifier = Modifier.semantics { heading() },
            style = TextStyle(
                color = Color.fg1,
                fontFamily = FontFamily.display,
                fontSize = 40.sp,
                letterSpacing = 0.04.em,
            ),
        )
    }
}
