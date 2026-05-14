# Upload neutrality

> Bytes that etch/it writes to the Autonomi network carry no etch/it
> identification.

## Principle

etch/it is a **tool**. Users decide what to publish. etch/it is not a
publisher, not a curator, not a host with editorial responsibility for
the bytes that pass through it. The tool exists to put the user's
content on Autonomi and step back.

So the bytes that land on the network are the user's content plus the
minimum scaffolding required to render it. Nothing in those bytes
identifies etch/it as the writer. Concretely:

| What's in the uploaded bytes | What's not |
|---|---|
| The user's title, body, files, and media — as-is | A `generator` meta tag |
| Minimal inline CSS / HTML structure to make the page readable | A wordmark, logo, brand mark, or favicon pointing to us |
| The etch/it envelope format (`{"v":1, "meta":…, "content":…}`) when used | A "published with etch/it" / "made on etchit.io" footer |
| Color and font choices (not names — palette only) | Any link, attribution, or copyright stamp naming etch/it |

The envelope format is recognisable by *shape*, but contains no literal
"etch/it" or "etchit" string. fetch>it sniffs the shape to render with
a title; that's an interop choice, not a brand stamp.

## Why this matters

Two reasons it earns the rule rather than being a preference:

1. **Liability surface.** A user uploads something that turns out to be
   copyright-infringing. The page is then crawled or screen-shot for a
   takedown request. If the bytes carry "made with etch/it" or
   "etchit.io", the plaintiff has our name to add to the complaint by
   reflex — not because we hosted anything (Autonomi did), but because
   they grep'd the page. Removing the brand string is the cheapest
   defence: we *are* a tool, the bytes *demonstrate* we're a tool.
2. **User trust.** Bloggers don't want to advertise the tool they
   composed in any more than writers want to advertise their word
   processor. A neutral output respects the user's authorial choice.

## What about advertising etch/it?

We advertise etch/it on **shared artifacts**, not **uploaded artifacts**.
The QR-share card (see `docs/QR-SHARE.md`) is local to the sender's
phone and the recipient's screen — it's a piece of UI that travels via
email / SMS / chat, not via Autonomi. Branding it spreads the project.
The blog post on Autonomi is the user's. Different surface, different
rule.

## Carve-outs

There are none today. If a future feature needs to embed something
recognisably ours in the uploaded bytes, write it down here with the
reason and the explicit user-visible opt-in. Silence is consent to the
default: neutral.

## Where this is enforced

- **Android**: `app/src/main/java/com/autonomi/antpaste/BlogHtml.kt`
  emits the blog HTML; `app/src/test/java/com/autonomi/antpaste/BlogHtmlTest.kt`
  asserts the output contains no literal `etchit` / `etch/it` /
  `etchit.io` strings and no `name="generator"` meta.
- **Desktop (Tauri 2, in development)**: `apps/etchit-desktop/`. The
  Blogger and Website tabs follow the same rule when implemented;
  matching tests live alongside each module.
- **FFI** (`ffi/rust/`) and the underlying `ant-ffi` write raw bytes —
  they don't add anything of their own to the user's content.

## What's not covered (and never will be)

- **Image / video / EPUB / PDF EXIF or XMP metadata that the user
  brought along.** We never strip or rewrite that — it's the user's
  responsibility. Stripping it for them risks destroying provenance the
  user wants preserved. If a user wants metadata-stripped output, they
  strip it before handing the file to etch/it.
- **On-chain artifacts** (chainmarks). The chainmark payload is a wire
  format defined by the protocol, not a brand stamp. It carries no
  literal "etchit" string. See `docs/chainmark-format-v1.md`.
- **fetch>it's rendering of the blog.** Once the bytes are on the
  network, every reader's renderer can frame them however it wants.
  fetch>it adds chrome — title, address, share button — *outside* the
  iframe. Inside the iframe, only the user's bytes.
