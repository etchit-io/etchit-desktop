package com.autonomi.antpaste.util

// First line of a Throwable's message — strips nested stack traces that
// Reown's SDK stuffs into outer throwables via `stackTraceToString()`.
// Keeps status banners readable instead of painting a wall of text.
fun Throwable.shortMessage(): String =
    message?.lineSequence()?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        ?: javaClass.simpleName
