package com.autonomi.antpaste

import android.graphics.Typeface
import android.text.Editable
import android.text.Spannable
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan

/**
 * Lightweight token-coloring for the fullscreen editor.
 *
 * Each language is a regex-based pass that walks the buffer, finds matches,
 * and stamps `ForegroundColorSpan` (and occasionally `StyleSpan` for bold /
 * italic) on the relevant ranges. Re-application clears all prior spans first
 * so repeated calls don't pile up.
 *
 * Not a parser — pathological inputs (escaped quotes inside escaped quotes,
 * triple-quoted Python strings spanning megabytes, etc.) will fall back to
 * plain text gracefully rather than mis-color. Premium polish, not IDE-grade.
 */
interface SyntaxHighlighter {
    val displayName: String
    fun apply(editable: Editable)
}

object SyntaxHighlighters {
    // Brand-aligned palette. Two non-brand colours (sand + sage) introduced
    // for strings and numbers because copper variants alone don't give enough
    // visual separation.
    private const val DEFAULT  = 0xFFf5f2eb.toInt() // bone — left implicit
    private const val KEYWORD  = 0xFFc9732b.toInt() // copper
    private const val LITERAL  = 0xFFe58a3f.toInt() // copper-bright
    private const val STRING   = 0xFFb8a37e.toInt() // warm sand
    private const val NUMBER   = 0xFFa3b5a8.toInt() // soft sage
    private const val COMMENT  = 0xFF8a8a8a.toInt() // ash

    /** Strip every coloring/style span we may have added on a previous pass. */
    fun clear(e: Editable) {
        for (span in e.getSpans(0, e.length, ForegroundColorSpan::class.java)) e.removeSpan(span)
        for (span in e.getSpans(0, e.length, StyleSpan::class.java)) e.removeSpan(span)
    }

    private fun color(e: Editable, start: Int, end: Int, c: Int) {
        e.setSpan(ForegroundColorSpan(c), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    private fun style(e: Editable, start: Int, end: Int, style: Int) {
        e.setSpan(StyleSpan(style), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    /** All registered highlighters in user-pickable order. */
    val all: List<SyntaxHighlighter> = listOf(
        PlainHighlighter, JsonHighlighter, MarkdownHighlighter, BashHighlighter, PythonHighlighter,
    )

    // ── Plain ──────────────────────────────────────────────────────────────
    object PlainHighlighter : SyntaxHighlighter {
        override val displayName = "Plain"
        override fun apply(editable: Editable) { clear(editable) }
    }

    // ── JSON ───────────────────────────────────────────────────────────────
    object JsonHighlighter : SyntaxHighlighter {
        override val displayName = "JSON"
        private val stringRe = Regex("\"(?:[^\"\\\\]|\\\\.)*\"")
        private val keyRe    = Regex("(\"(?:[^\"\\\\]|\\\\.)*\")\\s*:")
        private val numberRe = Regex("(?<![A-Za-z_])-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?")
        private val literalRe = Regex("\\b(true|false|null)\\b")
        override fun apply(editable: Editable) {
            clear(editable)
            val s = editable.toString()
            // Numbers + literals first so they're below strings/keys.
            for (m in numberRe.findAll(s))  color(editable, m.range.first, m.range.last + 1, NUMBER)
            for (m in literalRe.findAll(s)) color(editable, m.range.first, m.range.last + 1, LITERAL)
            // Strings as values — sand.
            for (m in stringRe.findAll(s))  color(editable, m.range.first, m.range.last + 1, STRING)
            // Keys override the value-colour with copper.
            for (m in keyRe.findAll(s)) {
                val k = m.groups[1] ?: continue
                color(editable, k.range.first, k.range.last + 1, KEYWORD)
            }
        }
    }

    // ── Markdown ───────────────────────────────────────────────────────────
    object MarkdownHighlighter : SyntaxHighlighter {
        override val displayName = "Markdown"
        private val headingRe   = Regex("(?m)^(#{1,6})\\s.+$")
        private val boldRe      = Regex("\\*\\*([^*\\n]+)\\*\\*")
        private val italicRe    = Regex("(?<![*_])(?:\\*([^*\\n]+)\\*|_([^_\\n]+)_)(?![*_])")
        private val inlineCodeRe = Regex("`([^`\\n]+)`")
        private val codeBlockRe = Regex("(?s)```.*?```")
        private val linkRe      = Regex("\\[([^]\\n]+)]\\(([^)\\n]+)\\)")
        private val listMarkerRe = Regex("(?m)^\\s*([*+-])\\s")
        private val quoteRe     = Regex("(?m)^>.*$")
        override fun apply(editable: Editable) {
            clear(editable)
            val s = editable.toString()
            for (m in codeBlockRe.findAll(s))   color(editable, m.range.first, m.range.last + 1, STRING)
            for (m in inlineCodeRe.findAll(s))  color(editable, m.range.first, m.range.last + 1, STRING)
            for (m in headingRe.findAll(s)) {
                color(editable, m.range.first, m.range.last + 1, LITERAL)
                style(editable, m.range.first, m.range.last + 1, Typeface.BOLD)
            }
            for (m in boldRe.findAll(s))   style(editable, m.range.first, m.range.last + 1, Typeface.BOLD)
            for (m in italicRe.findAll(s)) style(editable, m.range.first, m.range.last + 1, Typeface.ITALIC)
            for (m in linkRe.findAll(s))   color(editable, m.range.first, m.range.last + 1, KEYWORD)
            for (m in listMarkerRe.findAll(s)) {
                val g = m.groups[1] ?: continue
                color(editable, g.range.first, g.range.last + 1, KEYWORD)
            }
            for (m in quoteRe.findAll(s)) color(editable, m.range.first, m.range.last + 1, COMMENT)
        }
    }

    // ── Bash ───────────────────────────────────────────────────────────────
    object BashHighlighter : SyntaxHighlighter {
        override val displayName = "Bash"
        private val keywords = setOf(
            "if", "then", "else", "elif", "fi",
            "for", "while", "until", "do", "done",
            "function", "case", "esac", "in", "select",
            "return", "exit", "break", "continue",
            "set", "unset", "export", "local", "readonly", "declare", "typeset",
            "alias", "unalias", "trap", "shift", "source",
        )
        private val keywordRe = Regex("\\b(${keywords.joinToString("|")})\\b")
        private val commentRe = Regex("(?m)#.*$")
        private val dqStringRe = Regex("\"(?:[^\"\\\\]|\\\\.)*\"")
        private val sqStringRe = Regex("'[^'\\n]*'")
        private val varRe = Regex("\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?")
        private val numberRe = Regex("(?<![A-Za-z_])\\d+\\b")
        override fun apply(editable: Editable) {
            clear(editable)
            val s = editable.toString()
            for (m in numberRe.findAll(s))  color(editable, m.range.first, m.range.last + 1, NUMBER)
            for (m in keywordRe.findAll(s)) color(editable, m.range.first, m.range.last + 1, KEYWORD)
            for (m in varRe.findAll(s))     color(editable, m.range.first, m.range.last + 1, LITERAL)
            for (m in dqStringRe.findAll(s)) color(editable, m.range.first, m.range.last + 1, STRING)
            for (m in sqStringRe.findAll(s)) color(editable, m.range.first, m.range.last + 1, STRING)
            for (m in commentRe.findAll(s)) color(editable, m.range.first, m.range.last + 1, COMMENT)
        }
    }

    // ── Python ─────────────────────────────────────────────────────────────
    object PythonHighlighter : SyntaxHighlighter {
        override val displayName = "Python"
        private val keywords = setOf(
            "def", "class", "lambda", "return", "yield",
            "if", "elif", "else", "for", "while",
            "try", "except", "finally", "raise",
            "import", "from", "as", "with",
            "in", "not", "and", "or", "is",
            "pass", "break", "continue", "del", "global", "nonlocal",
            "assert", "async", "await",
        )
        private val literals = setOf("None", "True", "False")
        private val keywordRe = Regex("\\b(${keywords.joinToString("|")})\\b")
        private val literalRe = Regex("\\b(${literals.joinToString("|")})\\b")
        private val commentRe = Regex("(?m)#.*$")
        // Triple-quoted first (must have priority over single-line strings).
        private val tripleStringRe = Regex("(?s)(?:'''.*?'''|\"\"\".*?\"\"\")")
        private val stringRe = Regex("[fFrRbB]{0,2}'(?:[^'\\\\\\n]|\\\\.)*'|[fFrRbB]{0,2}\"(?:[^\"\\\\\\n]|\\\\.)*\"")
        private val numberRe = Regex("(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?")
        private val decoratorRe = Regex("(?m)^\\s*@\\w+(?:\\.\\w+)*")
        override fun apply(editable: Editable) {
            clear(editable)
            val s = editable.toString()
            for (m in numberRe.findAll(s))    color(editable, m.range.first, m.range.last + 1, NUMBER)
            for (m in keywordRe.findAll(s))   color(editable, m.range.first, m.range.last + 1, KEYWORD)
            for (m in literalRe.findAll(s))   color(editable, m.range.first, m.range.last + 1, LITERAL)
            for (m in decoratorRe.findAll(s)) color(editable, m.range.first, m.range.last + 1, LITERAL)
            for (m in stringRe.findAll(s))    color(editable, m.range.first, m.range.last + 1, STRING)
            for (m in tripleStringRe.findAll(s)) color(editable, m.range.first, m.range.last + 1, STRING)
            for (m in commentRe.findAll(s))   color(editable, m.range.first, m.range.last + 1, COMMENT)
        }
    }
}
