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
/**
 * A token produced by tokenize(): the (start, end) range plus either a foreground
 * colour, a style flag (Typeface.BOLD / ITALIC), or both. Negative values mean
 * "no colour" / "no style".
 */
data class HighlightToken(
    val start: Int,
    val end: Int,
    val color: Int = -1,
    val style: Int = -1,
)

interface SyntaxHighlighter {
    val displayName: String

    /**
     * Walk the buffer once and produce a flat list of tokens. Pure function —
     * no Spannable allocations, no setSpan side-effects. The caller decides
     * which tokens to actually paint as spans (e.g. only ones in the visible
     * viewport). Cached across scrolls so the regex pass runs at most once
     * per text-change rather than once per scroll frame.
     */
    fun tokenize(text: CharSequence): List<HighlightToken>
}

/** Apply [tokens] within the [rangeStart, rangeEnd) range to [editable]. */
fun SyntaxHighlighter.applyTokens(
    editable: Editable, tokens: List<HighlightToken>, rangeStart: Int, rangeEnd: Int,
) {
    SyntaxHighlighters.clear(editable)
    for (t in tokens) {
        if (t.end <= rangeStart || t.start >= rangeEnd) continue
        // The "no value" sentinel is -1 (default in HighlightToken). Plain
        // ">= 0" doesn't work because ARGB colours with full alpha are
        // negative when read as a signed Int, so we'd reject every brand colour.
        if (t.color != -1) editable.setSpan(
            ForegroundColorSpan(t.color), t.start, t.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
        if (t.style != -1) editable.setSpan(
            StyleSpan(t.style), t.start, t.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
    }
}

/** Whole-doc apply convenience — tokenize + applyTokens with full range. */
fun SyntaxHighlighter.apply(editable: Editable, rangeStart: Int = 0, rangeEnd: Int = editable.length) {
    applyTokens(editable, tokenize(editable), rangeStart, rangeEnd)
}

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

    /** Append every match of [re] to [out] as a coloured token. */
    private fun colorRule(out: MutableList<HighlightToken>, s: String, re: Regex, c: Int) {
        for (m in re.findAll(s)) out += HighlightToken(m.range.first, m.range.last + 1, color = c)
    }

    /** Append every match of [re] to [out] as a styled (bold/italic) token. */
    private fun styleRule(out: MutableList<HighlightToken>, s: String, re: Regex, styleFlag: Int) {
        for (m in re.findAll(s)) out += HighlightToken(m.range.first, m.range.last + 1, style = styleFlag)
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
        override fun tokenize(text: CharSequence): List<HighlightToken> = emptyList()
    }

    // ── JSON ───────────────────────────────────────────────────────────────
    object JsonHighlighter : SyntaxHighlighter {
        override val displayName = "JSON"
        private val stringRe = Regex("\"(?:[^\"\\\\]|\\\\.)*\"")
        private val keyRe    = Regex("(\"(?:[^\"\\\\]|\\\\.)*\")\\s*:")
        private val numberRe = Regex("(?<![A-Za-z_])-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?")
        private val literalRe = Regex("\\b(true|false|null)\\b")
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, literalRe, LITERAL)
            colorRule(out, s, stringRe, STRING)
            for (m in keyRe.findAll(s)) {
                val k = m.groups[1] ?: continue
                out += HighlightToken(k.range.first, k.range.last + 1, color = KEYWORD)
            }
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, codeBlockRe, STRING)
            colorRule(out, s, inlineCodeRe, STRING)
            for (m in headingRe.findAll(s)) {
                out += HighlightToken(m.range.first, m.range.last + 1, color = LITERAL, style = Typeface.BOLD)
            }
            styleRule(out, s, boldRe, Typeface.BOLD)
            styleRule(out, s, italicRe, Typeface.ITALIC)
            colorRule(out, s, linkRe, KEYWORD)
            for (m in listMarkerRe.findAll(s)) {
                val g = m.groups[1] ?: continue
                out += HighlightToken(g.range.first, g.range.last + 1, color = KEYWORD)
            }
            colorRule(out, s, quoteRe, COMMENT)
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, keywordRe, KEYWORD)
            colorRule(out, s, varRe, LITERAL)
            colorRule(out, s, dqStringRe, STRING)
            colorRule(out, s, sqStringRe, STRING)
            colorRule(out, s, commentRe, COMMENT)
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, keywordRe, KEYWORD)
            colorRule(out, s, literalRe, LITERAL)
            colorRule(out, s, decoratorRe, LITERAL)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, tripleStringRe, STRING)
            colorRule(out, s, commentRe, COMMENT)
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, keywordRe, KEYWORD)
            colorRule(out, s, literalRe, LITERAL)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, commentBlockRe, COMMENT)
            colorRule(out, s, commentLineRe, COMMENT)
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, keywordRe, KEYWORD)
            colorRule(out, s, literalRe, LITERAL)
            colorRule(out, s, annotationRe, LITERAL)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, tripleStringRe, STRING)
            colorRule(out, s, commentBlockRe, COMMENT)
            colorRule(out, s, commentLineRe, COMMENT)
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, keywordRe, KEYWORD)
            colorRule(out, s, literalRe, LITERAL)
            colorRule(out, s, attributeRe, LITERAL)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, commentBlockRe, COMMENT)
            colorRule(out, s, commentLineRe, COMMENT)
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, keywordRe, KEYWORD)
            colorRule(out, s, literalRe, LITERAL)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, commentBlockRe, COMMENT)
            colorRule(out, s, commentLineRe, COMMENT)
            return out
        }
    }

    // ── HTML ───────────────────────────────────────────────────────────────
    object HtmlHighlighter : SyntaxHighlighter {
        override val displayName = "HTML"
        private val commentRe = Regex("(?s)<!--.*?-->")
        private val stringRe = Regex("\"[^\"]*\"|'[^']*'")
        private val tagRe = Regex("</?[A-Za-z][\\w-]*|>|/>")
        private val attrRe = Regex("\\b[A-Za-z-]+(?==)")
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, attrRe, LITERAL)
            colorRule(out, s, tagRe, KEYWORD)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, commentRe, COMMENT)
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, hexColorRe, LITERAL)
            colorRule(out, s, propertyRe, LITERAL)
            colorRule(out, s, atRuleRe, KEYWORD)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, commentRe, COMMENT)
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, literalRe, LITERAL)
            colorRule(out, s, keyRe, KEYWORD)
            colorRule(out, s, listMarkerRe, LITERAL)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, commentRe, COMMENT)
            return out
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
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, numberRe, NUMBER)
            colorRule(out, s, keywordRe, KEYWORD)
            colorRule(out, s, literalRe, LITERAL)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, commentBlockRe, COMMENT)
            colorRule(out, s, commentLineRe, COMMENT)
            return out
        }
    }
}
