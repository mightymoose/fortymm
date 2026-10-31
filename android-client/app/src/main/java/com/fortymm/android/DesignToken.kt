package com.fortymm.android

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily

/**
 * The design system's colour tokens that the app uses, from
 * `references/design-system/colors_and_type.css`. [cssName] is the CSS
 * variable's name without `--`.
 */
enum class DesignToken(val cssName: String, val argb: Long) {
    INK_950("ink-950", 0xFF0B0D12),
    CHALK_50("chalk-50", 0xFFF7F8FB);

    val color: Color get() = Color(argb)
}

val Color.Companion.bgApp: Color get() = DesignToken.INK_950.color
val Color.Companion.fg1: Color get() = DesignToken.CHALK_50.color

/** Bebas Neue, the design system's `--font-display`. Only the wordmark uses it. */
val FontFamily.Companion.display: FontFamily
    get() = FontFamily(Font(R.font.bebas_neue_regular))
