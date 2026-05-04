# tools

Standalone, no-install helpers that read etchit data on machines where
the mobile app isn't running. All crypto is client-side; no servers, no
accounts, no API keys.

## chainmarks.html / chainmarks.py — cross-device chain/it viewer

Lists your on-chain chainmarks on any desktop. Inputs: wallet address +
the 32-byte chainmark key from the mobile app (Settings → chain/it →
Back up chainmark key). Output: the same entries the mobile app shows,
each with the matching `ant` command pre-built so you can fetch
content from a terminal (`ant file download --output <name> <addr>`).

```bash
# Browser version
open tools/chainmarks.html                            # or double-click; works from file://

# CLI version
pip install cryptography                           # or: apt install python3-cryptography
python3 tools/chainmarks.py 0xYOURWALLET...           # prompts for key with no echo
echo "<key-hex>" | python3 tools/chainmarks.py 0x… -  # or pipe via stdin (one line)
```

The hosted copy of the browser version lives at **<https://etchit.io/chainmarks>** (deployed from a sibling website repo; keep both copies of `chainmarks.html` in sync when editing).

The browser version has two paths:

- **Connect wallet** (default, recommended). If you have a browser-extension wallet (MetaMask, Rabby, Coinbase, OKX, etc.), click *Connect wallet*, sign the same chainmark-derive message the mobile app uses, and the page recreates the key in WebCrypto automatically — no copy-paste from your phone. Uses EIP-1193 (`window.ethereum`) directly; no WalletConnect SDK or CDN dependency.
- **Manual key entry** (fallback). If you don't have a browser wallet (e.g., mobile-only wallet) or you're running the page from `file://` against a wallet that requires HTTPS, expand the *Or enter key manually* section and paste the 64-char key from the app's *Back up chainmark key* dialog.

Both are reference implementations of `docs/chainmark-format-v1.md` —
fully cross-checked against the Kotlin code in `app/`. Anyone with the
spec can write a third equivalent client.

The browser version queries [BlockScout](https://arbitrum.blockscout.com)
to enumerate your chainmark txs and decrypts each one with the supplied
key. Nothing leaves the page except that one HTTP request to BlockScout.

### Chainmark-key handling

The key is sensitive — anyone with it (plus your wallet address) can
decrypt your chainmark entries on chain. Both tools are designed to keep
it out of the obvious leak channels:

- **CLI**: read via `getpass()` (no terminal echo, no shell history) or
  piped from stdin. Never accepted on argv, so it stays out of `ps`,
  `~/.bash_history`, and `~/.zsh_history`.
- **Browser**: input is `<input type="password">` (masked by default,
  `autocomplete="new-password"` to discourage browser save). A "Show"
  toggle is available for paste verification. Key lives in JS memory
  only for the page's lifetime — closing the tab clears it.

Neither tool sends the key over the network; only the wallet address
goes to the indexer.

## decode.html / decode.py — private-etch backup decoder

For decoding offline backup files made via the app's "Backup to network"
flow (separate from chain/it — see `app/.../BackupCrypto.kt`).

```bash
# Browser version
open tools/decode.html

# CLI version
python3 tools/decode.py <backup-file>
```

Writes `backup.json` (a JSON array of `{dm, t, ts}` entries). To recover
the actual private-etch content:

```bash
echo -n '<hex from dm field>' | xxd -r -p > datamap.bin
ant file download --output etch-content datamap.bin
```

## Backup format (decode.{html,py})

```
magic   17 bytes   "ETCHIT_BACKUP_v1\n"
salt    16 bytes
iv      12 bytes
ct+tag  rest       AES-256-GCM ciphertext, 16-byte tag appended
key = PBKDF2-HMAC-SHA256(password, salt, 600_000, 32)
```

## Chainmark wire format (chainmarks.{html,py})

See [`../docs/chainmark-format-v1.md`](../docs/chainmark-format-v1.md) —
full normative spec including KDF, AEAD, padding buckets, payload JSON
schema, and replay rules.
