# Contributing to etchit

Thanks for considering a contribution. etchit is a small project and
every well-aimed PR makes a real difference — typo fixes, doc
improvements, bug reports, and feature work are all welcome.

## Quick guide

- **Small fixes** (typos, broken links, obvious bugs): just open a PR.
  No pre-discussion needed.
- **Bigger changes** (new features, refactors, dependency bumps,
  protocol-level work): open an issue first to talk through the
  approach. Saves both of us time if our directions disagree.
- **Bug reports**: a clear repro is the most valuable kind — what you
  did, what happened, what you expected. Logs from `adb logcat` filtered
  to `ant-paste|ant_ffi` are gold for network or FFI issues.

## The CLA, plainly

Before your first PR is merged, our friendly bot will ask you to sign a
short Contributor License Agreement. Reasons it exists, in plain terms:

- **You keep the copyright in your contributions.** The CLA does not
  assign or transfer ownership.
- **You license your work back to the project under the same GPL-3.0**
  the project already ships under, plus a patent grant covering your
  contribution.
- **It keeps the project's options open.** We have no current plan to
  relicense or dual-license, but if it ever became necessary years from
  now, the CLA means we don't have to track every contributor down to
  ask permission. You retain a permanent license to your own work.

Signing is one comment on your PR — `I have read the CLA Document and I
hereby sign the CLA`. The bot does the rest. The full text is at
[the CLA Gist](https://gist.github.com/etchit-io/84fee4a905a000c9540deda3c4a8f67d)
and is short enough to read in two minutes.

If the CLA is a hard no for you, that's understandable — please open an
issue describing the change and a maintainer will pick it up.

## Build & test

```bash
# Build debug APK
./gradlew assembleDebug

# Run unit tests
./gradlew testDebugUnitTest

# Run a single test class
./gradlew testDebugUnitTest --tests "com.autonomi.antpaste.wallet.Erc20Test"
```

Full architecture and build-from-source notes (including the FFI rebuild)
live in [`docs/FFI_BUILD.md`](docs/FFI_BUILD.md) and the project's
`CLAUDE.md` if you have access.

## Code style

- Match the surrounding code. We use ViewBinding (no `findViewById`),
  Kotlin coroutines for async, and XML layouts (Compose only for the
  AppKit modal).
- Default to no comments. Add one only when the *why* would surprise a
  reader (a hidden constraint, a workaround for a known bug, a subtle
  invariant). Skip comments that just describe what the code does.
- Don't add error handling, fallbacks, or validation for paths that
  can't actually happen — trust internal calls; only validate at system
  boundaries (user input, external APIs).

## Submitting

1. Fork → branch → make your change.
2. Run the tests locally: `./gradlew testDebugUnitTest`.
3. Push, open a PR against `main`. Describe what changed and why.
4. The CLA bot will comment if it's your first PR. Sign once and you're
   set for all future contributions.
5. A maintainer will review. We aim to respond within a few days.

## Licensing reminder

etchit is GPL-3.0. Your contributions are licensed under the same.
Anyone who receives a binary built from your contribution can request
the source under the GPL terms.

## Code of conduct

Be kind, be specific, no harassment or personal attacks. We don't have
a formal code of conduct yet because the project is small; the standard
"act in good faith" applies.
