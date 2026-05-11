package com.autonomi.antpaste

/**
 * Builds the self-contained HTML page that the blog composer etches to
 * the Autonomi network. fetch>it sniffs the leading `<!DOCTYPE html>` /
 * `<html` bytes and routes the response into a sandboxed WebView, so the
 * page renders as a real read view — not a text dump.
 *
 * Design constraints (from BLOG-V1-SPEC):
 *  - Inline CSS only. One external resource allowed: the Google Fonts
 *    stylesheet (JetBrains Mono + Instrument Serif). fetch>it permits
 *    that family.
 *  - Brand palette: ink #0a0a0a bg, bone #f5f2eb body, copper #c9732b
 *    accents.
 *  - Title in Instrument Serif italic. Body in JetBrains Mono.
 *  - ~62ch max-width, mobile-first (these get read on phones).
 *  - [/] mark top-left (small). Footer line:
 *      "published on the Autonomi network · etchit.io"
 *  - Title and body are HTML-escaped (`&`, `<`, `>`, `"`). No user
 *    HTML/JS execution. Body splits on blank lines into `<p>`s;
 *    single newlines collapse to whitespace inside a paragraph.
 */
object BlogHtml {

    /**
     * Render the blog post HTML. Inputs are escaped — caller passes raw
     * strings from the editor as-is.
     */
    fun render(title: String, body: String): String {
        val safeTitle = escape(title.trim())
        val paragraphs = body
            .replace("\r\n", "\n")
            .replace("\r", "\n")
            .split(Regex("\n[\t ]*\n+"))
            .map { para ->
                // Within a paragraph, treat single newlines as whitespace
                // (markdown-ish behaviour — keeps line wrap reflowing nicely
                // on phone widths). Preserves the user's content otherwise.
                escape(para.trim().replace(Regex("\\s+"), " "))
            }
            .filter { it.isNotEmpty() }

        val bodyHtml = if (paragraphs.isEmpty()) {
            "<p class=\"empty\">(this post has no body)</p>"
        } else {
            paragraphs.joinToString("\n") { "<p>$it</p>" }
        }

        // Single string template to keep the asset truly self-contained.
        // Indentation is intentionally tight — the result lands as bytes
        // on the Autonomi network and every byte costs ANT.
        return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="generator" content="etch/it blog v1">
<title>$safeTitle</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #0a0a0a;
    --ink-2: #141414;
    --copper: #c9732b;
    --bone: #f5f2eb;
    --ash: #8a8a8a;
    --hairline: #222;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--ink); color: var(--bone); }
  body {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
    font-size: 15px;
    line-height: 1.7;
    -webkit-font-smoothing: antialiased;
    -webkit-text-size-adjust: 100%;
  }
  .wrap {
    max-width: 62ch;
    margin: 0 auto;
    padding: 28px 22px 80px;
  }
  header {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 36px;
  }
  .mark { flex: 0 0 28px; height: 28px; }
  .mark svg { width: 100%; height: 100%; display: block; }
  .brand {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-weight: 500;
    font-size: 13px;
    letter-spacing: 0.02em;
    color: var(--ash);
  }
  .brand .slash { color: var(--copper); }
  h1.title {
    font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-weight: 400;
    font-size: clamp(34px, 7vw, 52px);
    line-height: 1.12;
    letter-spacing: -0.01em;
    margin: 0 0 28px;
    color: var(--bone);
  }
  hr.rule {
    border: 0;
    height: 1px;
    background: var(--copper);
    opacity: 0.7;
    margin: 0 0 28px;
    width: 40px;
  }
  article p {
    margin: 0 0 1.05em;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  article p.empty { color: var(--ash); font-style: italic; }
  footer {
    margin-top: 56px;
    padding-top: 16px;
    border-top: 1px solid var(--hairline);
    color: var(--ash);
    font-size: 12px;
    line-height: 1.5;
  }
  footer .accent { color: var(--copper); }
  ::selection { background: rgba(201,115,43,0.35); color: var(--bone); }
  @media (max-width: 480px) {
    body { font-size: 14.5px; }
    .wrap { padding: 22px 18px 56px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="mark" aria-hidden="true">
      <svg viewBox="30 42 48 24" xmlns="http://www.w3.org/2000/svg">
        <path fill="#c9732b" d="M 30 42 L 42 42 L 42 46 L 34 46 L 34 62 L 42 62 L 42 66 L 30 66 Z M 66 42 L 78 42 L 78 66 L 66 66 L 66 62 L 74 62 L 74 46 L 66 46 Z M 46 66 L 52 66 L 62 42 L 56 42 Z"/>
      </svg>
    </span>
    <span class="brand">etch<span class="slash">/</span>it</span>
  </header>
  <h1 class="title">$safeTitle</h1>
  <hr class="rule">
  <article>
$bodyHtml
  </article>
  <footer>
    published on the Autonomi network <span class="accent">·</span> etchit.io
  </footer>
</div>
</body>
</html>
"""
    }

    private fun escape(s: String): String =
        s.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
}
