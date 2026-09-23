package com.fortymm.android.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object FortyMMColor {
    val Ink950 = Color(0xFF0B0D12)
    val Ink900 = Color(0xFF11141B)
    val Ink600 = Color(0xFF2A3040)
    val Chalk50 = Color(0xFFF7F8FB)
    val Chalk300 = Color(0xFFA9B0C2)
    val Ball500 = Color(0xFFFF7A1A)
}

object FortyMMSpace {
    const val S2 = 8
    const val S4 = 16
    const val S6 = 24
    const val S8 = 32
}

private val FortyMMDarkColors = darkColorScheme(
    primary = FortyMMColor.Ball500,
    onPrimary = FortyMMColor.Ink950,
    background = FortyMMColor.Ink950,
    onBackground = FortyMMColor.Chalk50,
    surface = FortyMMColor.Ink900,
    onSurface = FortyMMColor.Chalk50,
    outline = FortyMMColor.Ink600,
)

@Composable
fun FortyMMTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = FortyMMDarkColors,
        typography = FortyMMTypography,
        content = content,
    )
}
