// Build the etch/it envelope JSON that wraps plain-text uploads. Byte-equivalent
// to `app/src/main/java/com/autonomi/antpaste/PasteUtils.kt::encodeEnvelope`
// on Android — same shape, same field order, same escaping rules. fetch>it
// sniffs this exact shape (top-level `v`, `meta.title`, `content`) and renders
// with a title bar; any drift here is silent rendering breakage on the reader.

export interface EnvelopeInput {
  title: string;
  body: string;
}

export function buildEnvelope({ title, body }: EnvelopeInput): string {
  const t = JSON.stringify(title.trim());
  const c = JSON.stringify(body);
  return `{"v":1,"meta":{"title":${t},"lang":""},"content":${c}}`;
}
