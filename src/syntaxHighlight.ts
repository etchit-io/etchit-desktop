// Lightweight token coloring for fetched text content. Each language is a
// single combined regex with named groups; the alternation order encodes
// priority (e.g. keys before strings in JSON, comments before keywords). HTML
// output uses `<span class="hl-*">` so colors are themed in styles.css.
//
// Not a parser — pathological inputs may mis-tokenize but won't break.

export type Language = {
  id: string;
  name: string;
  highlight: (s: string) => string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Walks the input with a combined regex; named groups map to CSS classes.
// `regex` must be /g; named groups must match `classMap` keys.
function tokenize(text: string, regex: RegExp, classMap: Record<string, string>): string {
  let html = "";
  let lastIdx = 0;
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    if (m.index > lastIdx) {
      html += escapeHtml(text.slice(lastIdx, m.index));
    }
    let cls: string | undefined;
    if (m.groups) {
      for (const [name, val] of Object.entries(m.groups)) {
        if (val !== undefined) {
          cls = classMap[name];
          break;
        }
      }
    }
    if (cls) {
      html += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
    } else {
      html += escapeHtml(m[0]);
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    html += escapeHtml(text.slice(lastIdx));
  }
  return html;
}

const COMMON_CLASSES: Record<string, string> = {
  comment: "hl-comment",
  string: "hl-string",
  keyword: "hl-keyword",
  literal: "hl-literal",
  number: "hl-number",
  decorator: "hl-literal",
  variable: "hl-literal",
  heading: "hl-heading",
  link: "hl-keyword",
  bold: "hl-bold",
  italic: "hl-italic",
  tag: "hl-keyword",
  attr: "hl-literal",
  selector: "hl-keyword",
  property: "hl-literal",
  value: "hl-string",
};

// ── Plain ───────────────────────────────────────────────────────────────
const plain: Language = {
  id: "plain",
  name: "Plain",
  highlight: (s) => escapeHtml(s),
};

// ── JSON ────────────────────────────────────────────────────────────────
const json: Language = {
  id: "json",
  name: "JSON",
  highlight: (s) => tokenize(
    s,
    /(?<keyword>"(?:[^"\\]|\\.)*"(?=\s*:))|(?<string>"(?:[^"\\]|\\.)*")|(?<literal>\b(?:true|false|null)\b)|(?<number>-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    COMMON_CLASSES,
  ),
};

// ── Markdown ────────────────────────────────────────────────────────────
// Markdown without fenced-block routing — used for prose between blocks.
// (The triple-backtick alternative is removed from the string capture so
// fenced blocks are handled separately with sub-language embedding.)
const markdownOnly = (s: string) => tokenize(
  s,
  /(?<comment>^>.*$)|(?<heading>^#{1,6} .*$)|(?<string>`[^`\n]+`)|(?<link>\[[^\]\n]+\]\([^)\n]+\))|(?<keyword>^\s*[-*+] )|(?<bold>\*\*[^*\n]+\*\*)|(?<italic>(?<![*_])\*[^*\n]+\*(?![*_])|(?<![*_])_[^_\n]+_(?![*_]))/gm,
  COMMON_CLASSES,
);

const markdown: Language = {
  id: "markdown",
  name: "Markdown",
  highlight: (s) => {
    type Block = { fenceStart: number; bodyStart: number; bodyEnd: number; fenceEnd: number; lang: Language | null };
    const blocks: Block[] = [];
    const re = /```(\w+)?[ \t]*\n?([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const hint = m[1] ?? null;
      const body = m[2] ?? "";
      const fenceStart = m.index;
      const bodyStart = fenceStart + m[0].indexOf(body);
      const bodyEnd = bodyStart + body.length;
      const fenceEnd = fenceStart + m[0].length;
      blocks.push({ fenceStart, bodyStart, bodyEnd, fenceEnd, lang: langForHint(hint) });
    }
    let out = "";
    let pos = 0;
    for (const b of blocks) {
      if (b.fenceStart > pos) out += markdownOnly(s.slice(pos, b.fenceStart));
      // Opening fence + optional lang hint, then closing fence — both painted
      // as STRING. Body in between is the embedded language (or escaped text
      // when the language isn't recognised).
      out += `<span class="hl-string">${escapeHtml(s.slice(b.fenceStart, b.bodyStart))}</span>`;
      out += b.lang
        ? b.lang.highlight(s.slice(b.bodyStart, b.bodyEnd))
        : `<span class="hl-string">${escapeHtml(s.slice(b.bodyStart, b.bodyEnd))}</span>`;
      out += `<span class="hl-string">${escapeHtml(s.slice(b.bodyEnd, b.fenceEnd))}</span>`;
      pos = b.fenceEnd;
    }
    if (pos < s.length) out += markdownOnly(s.slice(pos));
    return out;
  },
};

/** Resolve a fenced-code-block hint to a Language, null if unknown. */
function langForHint(hint: string | null): Language | null {
  if (!hint) return null;
  switch (hint.toLowerCase()) {
    case "python": case "py": return python;
    case "javascript": case "js": case "typescript": case "ts": case "jsx": case "tsx": return jsts;
    case "bash": case "sh": case "shell": case "zsh": return bash;
    case "kotlin": case "kt": case "kts": return kotlin;
    case "rust": case "rs": return rust;
    case "go": case "golang": return go;
    case "html": case "xml": case "svg": return html;
    case "css": case "scss": return css;
    case "yaml": case "yml": return yaml;
    case "sql": return sql;
    case "json": case "jsonc": return json;
    default: return null;
  }
}

// ── Bash ────────────────────────────────────────────────────────────────
const bash: Language = {
  id: "bash",
  name: "Bash",
  highlight: (s) => tokenize(
    s,
    /(?<comment>#.*$)|(?<string>"(?:[^"\\]|\\.)*"|'[^'\n]*')|(?<variable>\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)|(?<keyword>\b(?:if|then|else|elif|fi|for|while|until|do|done|function|case|esac|in|select|return|exit|break|continue|set|unset|export|local|readonly|declare|typeset|alias|unalias|trap|shift|source)\b)|(?<number>(?<![A-Za-z_])\d+\b)/gm,
    COMMON_CLASSES,
  ),
};

// ── Python ──────────────────────────────────────────────────────────────
const python: Language = {
  id: "python",
  name: "Python",
  highlight: (s) => tokenize(
    s,
    /(?<comment>#.*$)|(?<string>(?:'''[\s\S]*?'''|"""[\s\S]*?""")|(?:[fFrRbB]{0,2}'(?:[^'\\\n]|\\.)*'|[fFrRbB]{0,2}"(?:[^"\\\n]|\\.)*"))|(?<decorator>@\w+(?:\.\w+)*)|(?<keyword>\b(?:def|class|lambda|return|yield|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|in|not|and|or|is|pass|break|continue|del|global|nonlocal|assert|async|await)\b)|(?<literal>\b(?:None|True|False)\b)|(?<number>(?<![A-Za-z_])\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gm,
    COMMON_CLASSES,
  ),
};

// ── JavaScript / TypeScript ────────────────────────────────────────────
const jstsKeywords = [
  "var", "let", "const", "function", "class", "extends", "new", "this", "super",
  "return", "yield", "async", "await",
  "if", "else", "for", "while", "do", "switch", "case", "default",
  "break", "continue", "try", "catch", "finally", "throw",
  "typeof", "instanceof", "in", "of",
  "import", "from", "export", "as",
  "interface", "type", "enum", "implements",
  "public", "private", "protected", "static", "readonly", "abstract",
  "namespace", "declare", "module",
].join("|");
// Common built-in globals + constructors — coloured as literals so the
// usual touchpoints to the runtime (document, fetch, JSON, ...) get
// visual punctuation rather than blending into bare identifiers.
const jstsBuiltins = [
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
].join("|");
const jsts: Language = {
  id: "jsts",
  name: "JS / TS",
  highlight: (s) => tokenize(
    s,
    new RegExp(
      `(?<comment>\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/)|(?<string>"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(?<keyword>\\b(?:${jstsKeywords})\\b)|(?<builtin>\\b(?:${jstsBuiltins})\\b)|(?<literal>\\b(?:true|false|null|undefined|NaN|Infinity)\\b)|(?<number>(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
      "gm",
    ),
    { ...COMMON_CLASSES, builtin: "hl-literal" },
  ),
};

// ── Kotlin ──────────────────────────────────────────────────────────────
const kotlinKeywords = [
  "fun", "val", "var", "class", "object", "interface", "enum", "data", "sealed",
  "abstract", "open", "override", "private", "public", "protected", "internal",
  "inline", "suspend", "infix", "operator", "external", "tailrec", "reified",
  "companion", "init", "constructor",
  "return", "yield", "if", "else", "when", "is", "in", "for", "while", "do",
  "try", "catch", "finally", "throw", "break", "continue",
  "import", "package", "as", "this", "super", "by",
].join("|");
const kotlin: Language = {
  id: "kotlin",
  name: "Kotlin",
  highlight: (s) => tokenize(
    s,
    new RegExp(
      `(?<comment>\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/)|(?<string>"""[\\s\\S]*?"""|"(?:[^"\\\\]|\\\\.)*")|(?<decorator>@\\w+(?:\\.\\w+)*)|(?<keyword>\\b(?:${kotlinKeywords})\\b)|(?<literal>\\b(?:true|false|null)\\b)|(?<number>(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[fFlL]?)`,
      "gm",
    ),
    COMMON_CLASSES,
  ),
};

// ── Rust ────────────────────────────────────────────────────────────────
const rustKeywords = [
  "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait",
  "use", "mod", "pub", "crate", "self", "Self",
  "return", "if", "else", "match", "for", "while", "loop", "break", "continue",
  "in", "where", "as", "ref", "move", "async", "await", "dyn", "unsafe", "extern",
  "type", "union",
].join("|");
const rust: Language = {
  id: "rust",
  name: "Rust",
  highlight: (s) => tokenize(
    s,
    new RegExp(
      `(?<comment>\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/)|(?<string>"(?:[^"\\\\]|\\\\.)*")|(?<decorator>#!?\\[[^\\]]*\\])|(?<keyword>\\b(?:${rustKeywords})\\b)|(?<literal>\\b(?:true|false|None|Some|Ok|Err)\\b)|(?<number>(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[ui](?:8|16|32|64|128|size)|[fF](?:32|64))?)`,
      "gm",
    ),
    COMMON_CLASSES,
  ),
};

// ── Go ──────────────────────────────────────────────────────────────────
const goKeywords = [
  "func", "var", "const", "type", "struct", "interface", "map", "chan",
  "range", "return", "if", "else", "for", "switch", "case", "default", "select",
  "break", "continue", "fallthrough", "goto", "defer", "go", "package", "import",
].join("|");
const go: Language = {
  id: "go",
  name: "Go",
  highlight: (s) => tokenize(
    s,
    new RegExp(
      `(?<comment>\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/)|(?<string>"(?:[^"\\\\]|\\\\.)*"|\`[^\`]*\`)|(?<keyword>\\b(?:${goKeywords})\\b)|(?<literal>\\b(?:true|false|nil|iota)\\b)|(?<number>(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
      "gm",
    ),
    COMMON_CLASSES,
  ),
};

// ── HTML ────────────────────────────────────────────────────────────────
// Tokenize HTML alone — used outside <style> / <script> body regions.
const htmlOnly = (s: string) => tokenize(
  s,
  /(?<comment><!--[\s\S]*?-->)|(?<string>"[^"]*"|'[^']*')|(?<tag><\/?[A-Za-z][\w-]*|>|\/>)|(?<attr>\b[A-Za-z-]+(?==))/g,
  COMMON_CLASSES,
);

const html: Language = {
  id: "html",
  name: "HTML",
  highlight: (s) => {
    // Locate every <style>…</style> and <script>…</script> body. Highlight
    // those bodies with the embedded language; highlight everything else
    // (including the wrapping tags themselves) as plain HTML. Then
    // concatenate the rendered HTML strings in document order.
    type Block = { bodyStart: number; bodyEnd: number; lang: Language };
    const blocks: Block[] = [];
    const collect = (re: RegExp, lang: Language) => {
      let m: RegExpExecArray | null;
      const r = new RegExp(re.source, re.flags);
      while ((m = r.exec(s)) !== null) {
        const body = m[1];
        if (body === undefined) continue;
        // Absolute body start = match start + offset of body within match.
        const localBodyStart = m[0].indexOf(body);
        blocks.push({
          bodyStart: m.index + localBodyStart,
          bodyEnd: m.index + localBodyStart + body.length,
          lang,
        });
      }
    };
    collect(/<style[^>]*>([\s\S]*?)<\/style>/gi, css);
    collect(/<script[^>]*>([\s\S]*?)<\/script>/gi, jsts);
    blocks.sort((a, b) => a.bodyStart - b.bodyStart);

    let result = "";
    let pos = 0;
    for (const b of blocks) {
      if (b.bodyStart > pos) result += htmlOnly(s.slice(pos, b.bodyStart));
      result += b.lang.highlight(s.slice(b.bodyStart, b.bodyEnd));
      pos = b.bodyEnd;
    }
    if (pos < s.length) result += htmlOnly(s.slice(pos));
    return result;
  },
};

// ── CSS ─────────────────────────────────────────────────────────────────
const css: Language = {
  id: "css",
  name: "CSS",
  highlight: (s) => tokenize(
    s,
    /(?<comment>\/\*[\s\S]*?\*\/)|(?<string>"[^"]*"|'[^']*')|(?<property>[a-z-]+(?=\s*:))|(?<literal>#[0-9a-fA-F]{3,8}\b)|(?<number>(?<![A-Za-z_])-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?)|(?<keyword>@[a-z-]+|::?[a-z-]+(?:\([^)]*\))?)/g,
    COMMON_CLASSES,
  ),
};

// ── YAML ────────────────────────────────────────────────────────────────
const yaml: Language = {
  id: "yaml",
  name: "YAML",
  highlight: (s) => tokenize(
    s,
    /(?<comment>#.*$)|(?<string>"[^"]*"|'[^']*')|(?<keyword>^\s*[\w-]+(?=\s*:))|(?<decorator>^\s*-(?=\s))|(?<literal>\b(?:true|false|null|yes|no|~)\b)|(?<number>(?<![A-Za-z_])-?\d+(?:\.\d+)?\b)/gm,
    COMMON_CLASSES,
  ),
};

// ── SQL ─────────────────────────────────────────────────────────────────
const sqlKeywords = [
  "select", "from", "where", "insert", "into", "values", "update", "set", "delete",
  "create", "table", "index", "view", "drop", "alter",
  "join", "left", "right", "inner", "outer", "cross", "on",
  "and", "or", "not", "in", "is", "null", "like", "between", "exists",
  "order", "by", "group", "having", "limit", "offset", "distinct",
  "case", "when", "then", "else", "end", "as",
  "union", "all", "intersect", "except",
  "primary", "key", "foreign", "references", "default", "unique", "check", "constraint",
  "begin", "commit", "rollback", "transaction",
].join("|");
const sql: Language = {
  id: "sql",
  name: "SQL",
  highlight: (s) => tokenize(
    s,
    new RegExp(
      `(?<comment>--.*$|\\/\\*[\\s\\S]*?\\*\\/)|(?<string>'(?:[^'\\\\]|\\\\.)*')|(?<keyword>\\b(?:${sqlKeywords})\\b)|(?<literal>\\b(?:true|false|null)\\b)|(?<number>(?<![A-Za-z_])\\d+(?:\\.\\d+)?\\b)`,
      "gim",
    ),
    COMMON_CLASSES,
  ),
};

export const LANGUAGES: Language[] = [
  plain, json, markdown, bash, python, jsts, kotlin, rust, go, html, css, yaml, sql,
];

export function highlightAs(text: string, langId: string): string {
  const lang = LANGUAGES.find((l) => l.id === langId) ?? plain;
  return lang.highlight(text);
}

/**
 * Best-guess language ID from the buffer's content. Heuristic — first
 * non-blank line characteristics + a couple of whole-buffer shape checks.
 * Returns "plain" when no pattern matches confidently. The picker still
 * lets the user override if the guess is wrong.
 */
export function detectLanguage(text: string): string {
  const sample = text.slice(0, 2000);
  if (sample.trim().length === 0) return "plain";
  const firstLine = (sample.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  const lower = firstLine.toLowerCase();

  if (firstLine.startsWith("#!")) {
    if (lower.includes("python")) return "python";
    if (lower.includes("node") || lower.includes("deno")) return "jsts";
    return "bash";
  }
  if (lower.startsWith("<!doctype") || lower.startsWith("<html") || lower.startsWith("<?xml")) return "html";

  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    if (/"[\w-]+"\s*:/.test(trimmed.slice(0, 500))) return "json";
  }
  if (/^(#{1,6} |---$|\* |- |\d+\.\s|>\s)/.test(firstLine)) return "markdown";
  if (/^(def |class |import |from |if __name__|@\w+)/.test(firstLine)) return "python";
  if (/^(fun |val |var |package |object |class \w+(\s*:|\s*\())/.test(firstLine)) return "kotlin";
  if (/^(import|export|const|let|var|function|class|interface|type|async function|require\()/.test(firstLine)) return "jsts";
  if (/^(fn |use |mod |struct |enum |impl |pub |#!?\[)/.test(firstLine)) return "rust";
  if (/^(package |import |func )/.test(firstLine)) return "go";
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|BEGIN)\b/i.test(firstLine)) return "sql";
  if (/(?:^|\n)([.#]?[A-Za-z][\w-]*|::?[\w-]+|@\w+)[\w\s.,#:>-]*\{/.test(sample.slice(0, 800))) return "css";
  if (/(?:^|\n)[\w-]+:\s+\S/.test(sample.slice(0, 500))) return "yaml";
  return "plain";
}
