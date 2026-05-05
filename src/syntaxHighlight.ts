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
const markdown: Language = {
  id: "markdown",
  name: "Markdown",
  highlight: (s) => tokenize(
    s,
    /(?<comment>^>.*$)|(?<heading>^#{1,6} .*$)|(?<string>```[\s\S]*?```|`[^`\n]+`)|(?<link>\[[^\]\n]+\]\([^)\n]+\))|(?<keyword>^\s*[-*+] )|(?<bold>\*\*[^*\n]+\*\*)|(?<italic>(?<![*_])\*[^*\n]+\*(?![*_])|(?<![*_])_[^_\n]+_(?![*_]))/gm,
    COMMON_CLASSES,
  ),
};

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
const jsts: Language = {
  id: "jsts",
  name: "JS / TS",
  highlight: (s) => tokenize(
    s,
    new RegExp(
      `(?<comment>\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/)|(?<string>"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(?<keyword>\\b(?:${jstsKeywords})\\b)|(?<literal>\\b(?:true|false|null|undefined|NaN|Infinity)\\b)|(?<number>(?<![A-Za-z_])\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
      "gm",
    ),
    COMMON_CLASSES,
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
const html: Language = {
  id: "html",
  name: "HTML",
  highlight: (s) => tokenize(
    s,
    /(?<comment><!--[\s\S]*?-->)|(?<string>"[^"]*"|'[^']*')|(?<tag><\/?[A-Za-z][\w-]*|>|\/>)|(?<attr>\b[A-Za-z-]+(?==))/g,
    COMMON_CLASSES,
  ),
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
