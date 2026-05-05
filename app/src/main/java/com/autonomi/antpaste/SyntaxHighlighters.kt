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
    /**
     * Apply highlighting only for the [rangeStart, rangeEnd) character range.
     * Tokens that overlap the range get a span covering the full token (so
     * spans don't get truncated mid-word at viewport boundaries). Tokens
     * entirely outside the range are skipped — keeps span count bounded on
     * large documents where Android's Spannable hits a perf wall past ~5K
     * spans. Pass 0..editable.length for the whole-doc behaviour.
     */
    fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int)
}

/** Convenience: highlight the whole document. */
fun SyntaxHighlighter.apply(editable: Editable) = apply(editable, 0, editable.length)

object SyntaxHighlighters {
    // Strict brand palette — every colour is from etchit-brand.html.
    private const val DEFAULT  = 0xFFf5f2eb.toInt() // bone — left implicit
    private const val KEYWORD  = 0xFFc9732b.toInt() // copper
    private const val LITERAL  = 0xFFe58a3f.toInt() // copper-bright
    private const val STRING   = 0xFFd6cfc0.toInt() // bone-dim
    private const val NUMBER   = 0xFF6ab04c.toInt() // signal-ok
    private const val COMMENT  = 0xFF8a8a8a.toInt() // ash

    /** Strip every coloring/style span we may have added on a previous pass. */
    fun clear(e: Editable) {
        for (span in e.getSpans(0, e.length, ForegroundColorSpan::class.java)) e.removeSpan(span)
        for (span in e.getSpans(0, e.length, StyleSpan::class.java)) e.removeSpan(span)
    }

    /** Run [re] over [s] and apply [c] to every match that overlaps the range. */
    private fun colorRegex(
        e: Editable, s: String, re: Regex, c: Int, rangeStart: Int, rangeEnd: Int,
    ) {
        for (m in re.findAll(s)) {
            val mEnd = m.range.last + 1
            if (mEnd <= rangeStart || m.range.first >= rangeEnd) continue
            e.setSpan(ForegroundColorSpan(c), m.range.first, mEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    /** Run [re] over [s] and apply [styleFlag] to every match that overlaps the range. */
    private fun styleRegex(
        e: Editable, s: String, re: Regex, styleFlag: Int, rangeStart: Int, rangeEnd: Int,
    ) {
        for (m in re.findAll(s)) {
            val mEnd = m.range.last + 1
            if (mEnd <= rangeStart || m.range.first >= rangeEnd) continue
            e.setSpan(StyleSpan(styleFlag), m.range.first, mEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    /** All registered highlighters in user-pickable order. */
    val all: List<SyntaxHighlighter> = listOf(
        PlainHighlighter,
        JsonHighlighter, MarkdownHighlighter, BashHighlighter, PythonHighlighter,
        JsTsHighlighter, KotlinHighlighter, RustHighlighter, GoHighlighter,
        HtmlHighlighter, CssHighlighter, YamlHighlighter, SqlHighlighter,
    )

    // ── Plain ──────────────────────────────────────────────────────────────
    object PlainHighlighter : SyntaxHighlighter {
        override val displayName = "Plain"
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) { clear(editable) }
    }

    // ── JSON ───────────────────────────────────────────────────────────────
    object JsonHighlighter : SyntaxHighlighter {
        override val displayName = "JSON"
        private val stringRe = Regex("\"(?:[^\"\\\\]|\\\\.)*\"")
        private val keyRe    = Regex("(\"(?:[^\"\\\\]|\\\\.)*\")\\s*:")
        private val numberRe = Regex("(?<![A-Za-z_])-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?")
        private val literalRe = Regex("\\b(true|false|null)\\b")
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, literalRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            // Keys override the value-colour with copper.
            for (m in keyRe.findAll(s)) {
                val k = m.groups[1] ?: continue
                val ke = k.range.last + 1
                if (ke <= rangeStart || k.range.first >= rangeEnd) continue
                editable.setSpan(ForegroundColorSpan(KEYWORD), k.range.first, ke, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
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
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, codeBlockRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, inlineCodeRe, STRING, rangeStart, rangeEnd)
            for (m in headingRe.findAll(s)) {
                val mEnd = m.range.last + 1
                if (mEnd <= rangeStart || m.range.first >= rangeEnd) continue
                editable.setSpan(ForegroundColorSpan(LITERAL), m.range.first, mEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                editable.setSpan(StyleSpan(Typeface.BOLD), m.range.first, mEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            styleRegex(editable, s, boldRe, Typeface.BOLD, rangeStart, rangeEnd)
            styleRegex(editable, s, italicRe, Typeface.ITALIC, rangeStart, rangeEnd)
            colorRegex(editable, s, linkRe, KEYWORD, rangeStart, rangeEnd)
            for (m in listMarkerRe.findAll(s)) {
                val g = m.groups[1] ?: continue
                val ge = g.range.last + 1
                if (ge <= rangeStart || g.range.first >= rangeEnd) continue
                editable.setSpan(ForegroundColorSpan(KEYWORD), g.range.first, ge, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            colorRegex(editable, s, quoteRe, COMMENT, rangeStart, rangeEnd)
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
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, keywordRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, varRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, dqStringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, sqStringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentRe, COMMENT, rangeStart, rangeEnd)
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
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, keywordRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, literalRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, decoratorRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, tripleStringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentRe, COMMENT, rangeStart, rangeEnd)
        }
    }

    // ── JavaScript / TypeScript ────────────────────────────────────────────
    object JsTsHighlighter : SyntaxHighlighter {
        override val displayName = "JS / TS"
        private val keywords = setOf(
            "var", "let", "const", "function", "class", "extends", "new", "this", "super",
            "return", "yield", "async", "await",
            "if", "else", "for", "while", "do", "switch", "case", "default",
            "break", "continue", "try", "catch", "finally", "throw",
            "typeof", "instanceof", "in", "of",
            "import", "from", "export", "as",
            "interface", "type", "enum", "implements",
            "public", "private", "protected", "static", "readonly", "abstract",
            "namespace", "declare", "module",
        )
        private val keywordRe = Regex("\\b(${keywords.joinToString("|")})\\b")
        private val literalRe = Regex("\\b(true|false|null|undefined|NaN|Infinity)\\b")
        private val commentLineRe = Regex("(?m)//.*$")
        private val commentBlockRe = Regex("(?s)/\\*.*?\\*/")
        private val stringRe = Regex(
            "\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`",
        )
        private val numberRe = Regex("(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?")
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, keywordRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, literalRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentBlockRe, COMMENT, rangeStart, rangeEnd)
            colorRegex(editable, s, commentLineRe, COMMENT, rangeStart, rangeEnd)
        }
    }

    // ── Kotlin ─────────────────────────────────────────────────────────────
    object KotlinHighlighter : SyntaxHighlighter {
        override val displayName = "Kotlin"
        private val keywords = setOf(
            "fun", "val", "var", "class", "object", "interface", "enum", "data", "sealed",
            "abstract", "open", "override", "private", "public", "protected", "internal",
            "inline", "suspend", "infix", "operator", "external", "tailrec", "reified",
            "companion", "init", "constructor",
            "return", "yield", "if", "else", "when", "is", "in", "for", "while", "do",
            "try", "catch", "finally", "throw", "break", "continue",
            "import", "package", "as", "this", "super", "by",
        )
        private val keywordRe = Regex("\\b(${keywords.joinToString("|")})\\b")
        private val literalRe = Regex("\\b(true|false|null)\\b")
        private val commentLineRe = Regex("(?m)//.*$")
        private val commentBlockRe = Regex("(?s)/\\*.*?\\*/")
        private val tripleStringRe = Regex("(?s)\"\"\".*?\"\"\"")
        private val stringRe = Regex("\"(?:[^\"\\\\\\n]|\\\\.)*\"")
        private val annotationRe = Regex("@\\w+(?:\\.\\w+)*")
        private val numberRe = Regex("(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[fFlL]?")
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, keywordRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, literalRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, annotationRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, tripleStringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentBlockRe, COMMENT, rangeStart, rangeEnd)
            colorRegex(editable, s, commentLineRe, COMMENT, rangeStart, rangeEnd)
        }
    }

    // ── Rust ───────────────────────────────────────────────────────────────
    object RustHighlighter : SyntaxHighlighter {
        override val displayName = "Rust"
        private val keywords = setOf(
            "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait",
            "use", "mod", "pub", "crate", "self", "Self",
            "return", "if", "else", "match", "for", "while", "loop", "break", "continue",
            "in", "where", "as", "ref", "move", "async", "await", "dyn", "unsafe", "extern",
            "type", "union",
        )
        private val keywordRe = Regex("\\b(${keywords.joinToString("|")})\\b")
        private val literalRe = Regex("\\b(true|false|None|Some|Ok|Err)\\b")
        private val commentLineRe = Regex("(?m)//.*$")
        private val commentBlockRe = Regex("(?s)/\\*.*?\\*/")
        private val stringRe = Regex("\"(?:[^\"\\\\]|\\\\.)*\"")
        private val attributeRe = Regex("(?m)#!?\\[[^\\]]*\\]")
        private val numberRe = Regex("(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[ui](?:8|16|32|64|128|size)|[fF](?:32|64))?")
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, keywordRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, literalRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, attributeRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentBlockRe, COMMENT, rangeStart, rangeEnd)
            colorRegex(editable, s, commentLineRe, COMMENT, rangeStart, rangeEnd)
        }
    }

    // ── Go ─────────────────────────────────────────────────────────────────
    object GoHighlighter : SyntaxHighlighter {
        override val displayName = "Go"
        private val keywords = setOf(
            "func", "var", "const", "type", "struct", "interface", "map", "chan",
            "range", "return", "if", "else", "for", "switch", "case", "default", "select",
            "break", "continue", "fallthrough", "goto", "defer", "go", "package", "import",
        )
        private val keywordRe = Regex("\\b(${keywords.joinToString("|")})\\b")
        private val literalRe = Regex("\\b(true|false|nil|iota)\\b")
        private val commentLineRe = Regex("(?m)//.*$")
        private val commentBlockRe = Regex("(?s)/\\*.*?\\*/")
        private val stringRe = Regex("\"(?:[^\"\\\\]|\\\\.)*\"|`[^`]*`")
        private val numberRe = Regex("(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?")
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, keywordRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, literalRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentBlockRe, COMMENT, rangeStart, rangeEnd)
            colorRegex(editable, s, commentLineRe, COMMENT, rangeStart, rangeEnd)
        }
    }

    // ── HTML ───────────────────────────────────────────────────────────────
    object HtmlHighlighter : SyntaxHighlighter {
        override val displayName = "HTML"
        private val commentRe = Regex("(?s)<!--.*?-->")
        private val stringRe = Regex("\"[^\"]*\"|'[^']*'")
        private val tagRe = Regex("</?[A-Za-z][\\w-]*|>|/>")
        private val attrRe = Regex("\\b[A-Za-z-]+(?==)")
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, attrRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, tagRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentRe, COMMENT, rangeStart, rangeEnd)
        }
    }

    // ── CSS ────────────────────────────────────────────────────────────────
    object CssHighlighter : SyntaxHighlighter {
        override val displayName = "CSS"
        private val commentRe = Regex("(?s)/\\*.*?\\*/")
        private val stringRe = Regex("\"[^\"]*\"|'[^']*'")
        private val propertyRe = Regex("[a-z-]+(?=\\s*:)")
        private val hexColorRe = Regex("#[0-9a-fA-F]{3,8}\\b")
        private val numberRe = Regex("(?<![A-Za-z_])-?\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?")
        private val atRuleRe = Regex("@[a-z-]+")
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, hexColorRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, propertyRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, atRuleRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentRe, COMMENT, rangeStart, rangeEnd)
        }
    }

    // ── YAML ───────────────────────────────────────────────────────────────
    object YamlHighlighter : SyntaxHighlighter {
        override val displayName = "YAML"
        private val commentRe = Regex("(?m)#.*$")
        private val stringRe = Regex("\"[^\"]*\"|'[^']*'")
        private val keyRe = Regex("(?m)^\\s*[\\w-]+(?=\\s*:)")
        private val listMarkerRe = Regex("(?m)^\\s*-(?=\\s)")
        private val literalRe = Regex("\\b(true|false|null|yes|no|~)\\b")
        private val numberRe = Regex("(?<![A-Za-z_])-?\\d+(?:\\.\\d+)?\\b")
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, literalRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, keyRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, listMarkerRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentRe, COMMENT, rangeStart, rangeEnd)
        }
    }

    // ── SQL ────────────────────────────────────────────────────────────────
    object SqlHighlighter : SyntaxHighlighter {
        override val displayName = "SQL"
        private val keywords = setOf(
            "select", "from", "where", "insert", "into", "values", "update", "set", "delete",
            "create", "table", "index", "view", "drop", "alter",
            "join", "left", "right", "inner", "outer", "cross", "on",
            "and", "or", "not", "in", "is", "null", "like", "between", "exists",
            "order", "by", "group", "having", "limit", "offset", "distinct",
            "case", "when", "then", "else", "end", "as",
            "union", "all", "intersect", "except",
            "primary", "key", "foreign", "references", "default", "unique", "check", "constraint",
            "begin", "commit", "rollback", "transaction",
        )
        private val keywordRe = Regex("\\b(${keywords.joinToString("|")})\\b", RegexOption.IGNORE_CASE)
        private val literalRe = Regex("\\b(true|false|null)\\b", RegexOption.IGNORE_CASE)
        private val commentLineRe = Regex("(?m)--.*$")
        private val commentBlockRe = Regex("(?s)/\\*.*?\\*/")
        private val stringRe = Regex("'(?:[^'\\\\]|\\\\.)*'")
        private val numberRe = Regex("(?<![A-Za-z_])\\d+(?:\\.\\d+)?\\b")
        override fun apply(editable: Editable, rangeStart: Int, rangeEnd: Int) {
            clear(editable)
            val s = editable.toString()
            colorRegex(editable, s, numberRe, NUMBER, rangeStart, rangeEnd)
            colorRegex(editable, s, keywordRe, KEYWORD, rangeStart, rangeEnd)
            colorRegex(editable, s, literalRe, LITERAL, rangeStart, rangeEnd)
            colorRegex(editable, s, stringRe, STRING, rangeStart, rangeEnd)
            colorRegex(editable, s, commentBlockRe, COMMENT, rangeStart, rangeEnd)
            colorRegex(editable, s, commentLineRe, COMMENT, rangeStart, rangeEnd)
        }
    }
}
