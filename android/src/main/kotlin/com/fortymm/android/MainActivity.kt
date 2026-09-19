package com.fortymm.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import com.fortymm.android.home.HomeShell
import com.fortymm.android.ui.FortyMMTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { FortyMMApp() }
    }
}

@Composable
fun FortyMMApp() {
    FortyMMTheme {
        HomeShell()
    }
}
