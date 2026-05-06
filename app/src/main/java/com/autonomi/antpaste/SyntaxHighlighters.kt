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

/**
 * Apply [tokens] within the [rangeStart, rangeEnd) range to [editable].
 *
 * Pre-merges tokens by priority into one span per contiguous run of identical
 * (colour, style) — collapses the typical 5-7× span layering down to ~1× and
 * keeps the total span count well under Android's Spannable cliff (~5-7K spans,
 * past which `setSpan` calls quietly stop taking effect). Without this merge,
 * later-applied spans (strings, comments — the high-priority overrides) are
 * the ones that get dropped first when the cliff hits, which produced the
 * "patchy / wrong colour" symptoms on large docs.
 *
 * Priority follows token list order: tokens later in the list win for colour
 * and for style independently. A token with `color == -1` doesn't displace
 * the prior winner's colour, and similarly for style — so colour-only and
 * style-only tokens (e.g. markdown bold) stack with what came before, exactly
 * matching the previous last-applied-wins layering semantics.
 */
fun SyntaxHighlighter.applyTokens(
    editable: Editable, tokens: List<HighlightToken>, rangeStart: Int, rangeEnd: Int,
) {
    SyntaxHighlighters.clear(editable)
    if (tokens.isEmpty()) return
    val len = editable.length
    if (len == 0) return
    val rs = rangeStart.coerceAtLeast(0)
    val re = rangeEnd.coerceAtMost(len)
    if (rs >= re) return

    // Per-character winner: which token's colour and style currently apply,
    // tagged with the priority index of the token that set them.
    val winnerColor = IntArray(len) { -1 }
    val winnerStyle = IntArray(len) { -1 }
    val winnerPriority = IntArray(len) { -1 }
    for ((i, t) in tokens.withIndex()) {
        val s = t.start.coerceAtLeast(0)
        val e = t.end.coerceAtMost(len)
        if (e <= s) continue
        for (p in s until e) {
            if (i >= winnerPriority[p]) {
                winnerPriority[p] = i
                if (t.color != -1) winnerColor[p] = t.color
                if (t.style != -1) winnerStyle[p] = t.style
            }
        }
    }

    // Emit one span per maximal run of identical (colour, style) within range.
    var p = rs
    while (p < re) {
        val c = winnerColor[p]
        val st = winnerStyle[p]
        if (c == -1 && st == -1) { p++; continue }
        var q = p + 1
        while (q < re && winnerColor[q] == c && winnerStyle[q] == st) q++
        if (c != -1) editable.setSpan(
            ForegroundColorSpan(c), p, q, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
        if (st != -1) editable.setSpan(
            StyleSpan(st), p, q, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
        p = q
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

    /**
     * Best-guess language from the buffer's content. Heuristic — first
     * non-blank line characteristics + a couple of whole-buffer shape checks
     * (JSON braces, CSS rule blocks). Returns [PlainHighlighter] when no
     * pattern matches confidently, so the picker still shows Plain by default
     * for prose etches. The user can override via the language picker.
     */
    fun detectLanguage(text: CharSequence): SyntaxHighlighter {
        val sample = text.toString().take(2000)
        if (sample.isBlank()) return PlainHighlighter
        val firstLine = sample.lineSequence().firstOrNull { it.isNotBlank() }?.trim()
            ?: return PlainHighlighter
        val lower = firstLine.lowercase()

        // Shebang
        if (firstLine.startsWith("#!")) return when {
            "python" in lower -> PythonHighlighter
            "node" in lower || "deno" in lower -> JsTsHighlighter
            else -> BashHighlighter
        }

        // HTML / XML
        if (lower.startsWith("<!doctype") || lower.startsWith("<html") ||
            lower.startsWith("<?xml")) return HtmlHighlighter

        // JSON — whole-text shape
        val trimmed = text.toString().trim()
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
            (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
            if (Regex("\"[\\w-]+\"\\s*:").containsMatchIn(trimmed.take(500))) return JsonHighlighter
        }

        // Markdown — common opening patterns.
        if (Regex("^(#{1,6} |---$|\\* |- |\\d+\\.\\s|>\\s)").containsMatchIn(firstLine))
            return MarkdownHighlighter

        // Python — def / class / import / from / decorator / dunder.
        if (Regex("^(def |class |import |from |if __name__|@\\w+)").containsMatchIn(firstLine))
            return PythonHighlighter

        // Kotlin (checked before JS/TS — `fun` / `val` / `var` are distinct).
        if (Regex("^(fun |val |var |package |object |class \\w+(\\s*:|\\s*\\())").containsMatchIn(firstLine))
            return KotlinHighlighter

        // JS / TS
        if (Regex("^(import|export|const|let|var|function|class|interface|type|async function|require\\()").containsMatchIn(firstLine))
            return JsTsHighlighter

        // Rust
        if (Regex("^(fn |use |mod |struct |enum |impl |pub |#!?\\[)").containsMatchIn(firstLine))
            return RustHighlighter

        // Go
        if (Regex("^(package |import |func )").containsMatchIn(firstLine))
            return GoHighlighter

        // SQL — case-insensitive on the leading verb.
        if (Regex("(?i)^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|BEGIN)\\b").containsMatchIn(firstLine))
            return SqlHighlighter

        // CSS — rule blocks anywhere in the first 800 chars.
        if (Regex("(?m)^([.#]?[A-Za-z][\\w-]*|::?[\\w-]+|@\\w+)[\\w\\s.,#:>-]*\\{").containsMatchIn(sample.take(800)))
            return CssHighlighter

        // YAML — `key: value` shape on its own line.
        if (Regex("(?m)^[\\w-]+:\\s+\\S").containsMatchIn(sample.take(500)))
            return YamlHighlighter

        return PlainHighlighter
    }

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
        // Capture the language hint (group 1) and body (group 2) of a fenced
        // code block — body is routed through the embedded language so the
        // typical "```python\n...\n```" snippet looks right inside Markdown.
        private val codeBlockRe = Regex("(?s)```([\\w+-]*)?\\s*\\n?(.*?)```")
        private val linkRe      = Regex("\\[([^]\\n]+)]\\(([^)\\n]+)\\)")
        private val listMarkerRe = Regex("(?m)^\\s*([*+-])\\s")
        private val quoteRe     = Regex("(?m)^>.*$")
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            // Code blocks: fence + lang hint stay STRING, body is sub-language tokens.
            for (m in codeBlockRe.findAll(s)) {
                out += HighlightToken(m.range.first, m.range.last + 1, color = STRING)
                val langHint = m.groups[1]?.value?.lowercase()
                val body = m.groups[2] ?: continue
                val inner = languageForHint(langHint) ?: continue
                val sub = s.substring(body.range.first, body.range.last + 1)
                for (t in inner.tokenize(sub)) {
                    out += HighlightToken(
                        t.start + body.range.first,
                        t.end + body.range.first,
                        t.color, t.style,
                    )
                }
            }
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

    /** Resolve a fenced-code-block language hint to a highlighter, or null
     *  if we don't know the language (in which case the block stays STRING). */
    private fun languageForHint(hint: String?): SyntaxHighlighter? = when (hint) {
        null, "" -> null
        "python", "py" -> PythonHighlighter
        "javascript", "js", "jsx", "typescript", "ts", "tsx" -> JsTsHighlighter
        "bash", "sh", "shell", "zsh" -> BashHighlighter
        "kotlin", "kt", "kts" -> KotlinHighlighter
        "rust", "rs" -> RustHighlighter
        "go", "golang" -> GoHighlighter
        "html", "xml", "svg" -> HtmlHighlighter
        "css", "scss" -> CssHighlighter
        "yaml", "yml" -> YamlHighlighter
        "sql" -> SqlHighlighter
        "json", "jsonc" -> JsonHighlighter
        else -> null
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
        // Common built-in globals + constructors — coloured as literals so the
        // typical browser/Node script gets visual punctuation around the
        // points where it touches the runtime, not just at keywords.
        private val builtins = setOf(
            "document", "window", "globalThis", "self", "console", "navigator", "location",
            "history", "screen", "alert", "confirm", "prompt",
            "fetch", "Request", "Response", "Headers", "URL", "URLSearchParams",
            "setTimeout", "setInterval", "clearTimeout", "clearInterval",
            "requestAnimationFrame", "cancelAnimationFrame",
            "Math", "JSON", "Date", "Promise", "Symbol",
            "Array", "Object", "Number", "String", "Boolean", "BigInt",
            "Map", "Set", "WeakMap", "WeakSet",
            "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
            "RegExp", "Function", "Reflect", "Proxy",
            "Uint8Array", "Int8Array", "Uint16Array", "Int16Array",
            "Uint32Array", "Int32Array", "Float32Array", "Float64Array",
            "ArrayBuffer", "DataView",
        )
        private val keywordRe = Regex("\\b(${keywords.joinToString("|")})\\b")
        private val builtinRe = Regex("\\b(${builtins.joinToString("|")})\\b")
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
            colorRule(out, s, builtinRe, LITERAL)
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
        // Capture only the *content* between the opening/closing tags so the
        // sub-language tokens cover styles or script bodies, not the wrapper.
        private val styleBlockRe = Regex("(?si)<style[^>]*>(.*?)</style>")
        private val scriptBlockRe = Regex("(?si)<script[^>]*>(.*?)</script>")
        override fun tokenize(text: CharSequence): List<HighlightToken> {
            val s = text.toString()
            val out = mutableListOf<HighlightToken>()
            colorRule(out, s, attrRe, LITERAL)
            colorRule(out, s, tagRe, KEYWORD)
            colorRule(out, s, stringRe, STRING)
            colorRule(out, s, commentRe, COMMENT)
            // Sub-language passes (added after HTML tokens so their priority
            // wins inside their range — CSS rules inside <style>, JS inside
            // <script> get the right colour despite living in an HTML doc).
            embedSubLanguage(out, s, styleBlockRe, CssHighlighter)
            embedSubLanguage(out, s, scriptBlockRe, JsTsHighlighter)
            return out
        }
    }

    /** For each match of [outerRe] in [s], tokenize its first capture group
     *  with [inner] and merge the results back into [out] at the original
     *  document offsets. Used to embed CSS-in-style and JS-in-script under
     *  the HTML highlighter. Drops any HTML tokens that fall fully inside
     *  the body first — without that, HTML's attribute-like regex (\b\w+(?==))
     *  mis-paints JS assignments such as `x = 5` because there's no JS token
     *  for bare identifiers to override the HTML one. */
    private fun embedSubLanguage(
        out: MutableList<HighlightToken>,
        s: String,
        outerRe: Regex,
        inner: SyntaxHighlighter,
    ) {
        for (m in outerRe.findAll(s)) {
            val body = m.groups[1] ?: continue
            val bodyStart = body.range.first
            val bodyEnd = body.range.last + 1
            out.removeAll { it.start >= bodyStart && it.end <= bodyEnd }
            val sub = s.substring(bodyStart, bodyEnd)
            for (t in inner.tokenize(sub)) {
                out += HighlightToken(t.start + bodyStart, t.end + bodyStart, t.color, t.style)
            }
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
