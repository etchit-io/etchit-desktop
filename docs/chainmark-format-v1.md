# etchit cross-device chainmark format — v1

*Formerly known as "library v1" — same problem space, same wire-format approach, renamed to fit the chain/it brand family. Wire bytes are NOT compatible with library v1 — see §11.*

Normative wire-format specification for the etchit cross-device etch
chainmark index. Any client (Android, future Linux desktop, future web/Electron,
third-party Neovim plugin, …) MUST implement this spec verbatim to
interoperate.

This document defines:
- The off-chain encryption + framing format.
- The on-chain transaction shape.
- The chronological replay rules.
- Permanence and privacy properties any client MUST surface to users.

This document does NOT define UI; clients are free to render the
resulting chain/it however they choose.

---

## 1. Scope

v1 syncs **public-etch metadata only**: a per-wallet, encrypted, on-chain
index (a chainmark index) of `(etch_address, title, timestamp, action)` entries. Private
etches (those whose data map is held locally and never published) are
explicitly out of scope for v1. See §13 for the v2 expansion path.

The chainmark index is per-wallet. Each Arbitrum One wallet has at most one v1
chainmark index, identified entirely by its address. Clients MUST NOT merge
chainmark indices across wallets.

## 2. Conventions

- Byte ordering: little-endian unless explicitly stated otherwise.
- Hex: lowercase, no `0x` prefix unless the field is an Ethereum
  address (in which case the prefixed-checksum form MAY be used at
  display layer; the canonical form on the wire is lowercase hex with
  no prefix).
- Etch addresses (Autonomi xor-names): 32 bytes, encoded as 64-char
  lowercase hex, no `0x` prefix.
- Strings: UTF-8, no BOM.
- Timestamps: Unix seconds, signed 64-bit integer.
- JSON: RFC 8259, UTF-8, no BOM. Object key order is not significant.

## 3. Chain target

- Network: Arbitrum One.
- Chain ID: 42161.

Future versions MAY target other EVM chains. v1 clients MUST refuse to
read or write v1 libraries on any chain other than Arbitrum One.

### 3.1 Per-tx recipient derivation

Chainmark transactions are sent to a **fresh, deterministic, provably-
unowned address per transaction**, derived from the blob's nonce:

```
to = SHA-256("etchit-chainmark-v1/recipient" || nonce_12_bytes)[12:32]
```

The 27-byte ASCII prefix is fixed; the 12-byte nonce is the same one
embedded in the calldata blob (§7, offset 2).

Senders MUST set `to` to this exact address. Readers MUST verify
`to == recompute(data[2:14])` before attempting AEAD decryption — a
non-conforming `to` is a structural rejection, no wallet-key access
required.

The recipient is therefore:
- **Different per tx** (nonce is CSPRNG random per batch).
- **Verifiable from public calldata** (anyone can recompute).
- **Provably unowned** at 2^-160: owning the address would require a
  private key whose keccak256(public_key)[12:] collides with the
  SHA-256-derived 20 bytes.

This pattern serves three purposes:
1. Avoids wallet-imposed "no data to internal/self accounts" rejections
   (MetaMask, Coinbase Wallet) that block self-sends with calldata.
2. Prevents the global-enumeration leak that a single fixed sentinel
   would create — a chain observer cannot run one `WHERE to = X` query
   to find every etchit chainmark user.
3. Keeps the protocol etchit-agnostic: no contract is deployed, no
   single address is ever reused.

SHA-256 (rather than keccak) keeps verification implementable in any
language with stdlib primitives.

## 4. Key derivation

### 4.1 Sign message

Clients prompt the user's wallet to sign the following message via
EIP-191 `personal_sign`. The message is byte-exact: UTF-8, LF (`0x0A`)
line endings, no trailing newline.

```
etchit chainmark v1

Sign this message to derive your chainmark key. This signature does NOT authorize any transaction or transfer.
```

Concretely (no quotes; `\n` denotes the LF byte):

```
etchit chainmark v1\n\nSign this message to derive your chainmark key. This signature does NOT authorize any transaction or transfer.
```

The string is 137 bytes (UTF-8). SHA-256 of those bytes:
`ab6f4ae288e6053c3e2181c83e33065c870a8b58b76b1d6b0072aba658cecab0`.

The `personal_sign` prefix (`"\x19Ethereum Signed Message:\n" + len`)
is applied by the wallet per EIP-191 §6.b. Clients MUST NOT apply the
prefix themselves.

### 4.2 IKM

The signature returned by `personal_sign` is 65 bytes: `r (32) || s (32) || v (1)`.
The IKM (input keying material) for HKDF is the first 64 bytes:
`r || s`. The `v` byte is discarded.

### 4.3 HKDF

Algorithm: HKDF-SHA256 (RFC 5869).

| Input | Value |
|---|---|
| salt | empty (0 bytes) |
| IKM | 64 bytes (`r \|\| s`) |
| info | ASCII bytes `etchit-chainmark/v1/aead-key` (26 bytes) |
| L | 32 bytes |

Output: 32 bytes — the **chainmark AEAD key**.

### 4.4 Key cache

Clients SHOULD cache the derived key encrypted-at-rest (e.g. Android
Keystore, OS keychain), keyed by the lowercase hex wallet address. The
cache MUST be invalidated when the active wallet changes.

Clients MUST NOT persist the raw signature.

### 4.5 Determinism assumption (RFC 6979)

Re-deriving the same key on a different device requires the wallet to
produce the **same** signature for the same message. ECDSA signatures
are non-deterministic in general (random `k` nonce per signature), but
RFC 6979 specifies a deterministic-`k` variant that all major modern
wallet implementations (MetaMask, Rainbow, Trust, Coinbase, Reown
AppKit's reference signers) use.

A wallet that does NOT implement RFC 6979 will produce a different
signature on each call, derive a different key, and fail to decrypt
previously-encrypted chainmark entries. v1 clients SHOULD:

- Treat re-derivation as "best effort" — if the new key fails to
  AEAD-verify any existing entries on chain, surface a clear error
  rather than silently replacing the chainmark index.
- Offer the user a "Back up chainmark key" export so the 32-byte key
  itself can be saved (e.g. to a password manager) as a recovery
  backstop independent of wallet determinism.
- Offer a corresponding "Restore chainmark key" import that bypasses the
  signature flow entirely.

This is the only assumption v1 makes about wallet implementation
behavior beyond the EIP-191 wire format. Future versions MAY remove the
assumption by introducing a per-wallet on-chain salt; v1 trades that
complexity for simplicity.

## 5. AEAD

| Parameter | Value |
|---|---|
| Algorithm | AES-256-GCM (NIST SP 800-38D) |
| Key | 32 bytes (from §4.3) |
| Nonce | 12 bytes, generated per-batch from a CSPRNG |
| Associated data | empty |
| Tag | 16 bytes, appended to ciphertext |

A given `(key, nonce)` pair MUST never be reused. With a CSPRNG nonce,
the birthday bound for collision is ~2^48 batches per wallet, which is
unreachable in practice.

## 6. Padding buckets

Plaintext is padded to one of three fixed bucket sizes:

| bucket_id | bucket_size (bytes) |
|---|---|
| `0x00` | 1024 (1 KiB) |
| `0x01` | 4096 (4 KiB) |
| `0x02` | 16384 (16 KiB) |

Clients MUST select the smallest bucket that fits the framed plaintext
(see §8). If the framed plaintext does not fit in the largest bucket
(16 KiB), clients MUST split the entries across multiple batches.

Future versions MAY define additional bucket IDs.

## 7. Calldata blob layout

```
offset  size  field
   0     1    version          (= 0x01)
   1     1    bucket_id        (0x00, 0x01, or 0x02 in v1)
   2    12    nonce            (random per-batch)
  14    N     ciphertext+tag   (N = bucket_size + 16)
```

Total calldata length = `14 + bucket_size + 16`:

| bucket | total bytes |
|---|---|
| 1 KiB | 1054 |
| 4 KiB | 4126 |
| 16 KiB | 16414 |

The `version` byte governs the **envelope and crypto** format.
The `v` field inside the encrypted JSON payload (§9) governs the
**payload schema**. They evolve independently.

## 8. Plaintext frame

The 32-byte AEAD key encrypts a fixed-size plaintext laid out as:

```
offset  size           field
   0     4             payload_len     (u32 little-endian)
   4     payload_len   payload         (UTF-8 JSON bytes)
   4+L   bucket_size-4-L  zero padding (0x00 bytes)
```

Constraints:
- `4 + payload_len ≤ bucket_size`.
- The plaintext is **always** exactly `bucket_size` bytes — clients MUST
  zero-pad after the payload.
- Decoders MUST verify `payload_len + 4 ≤ bucket_size` and reject
  otherwise.
- Decoders MUST ignore the trailing zero padding.

## 9. Payload (JSON)

```json
{
  "v": 1,
  "entries": [
    {
      "kind": "public",
      "addr": "<64-char lowercase hex xor-name>",
      "title": "<UTF-8 string, 0–256 bytes>",
      "ts": 1714572800,
      "action": "add"
    }
  ]
}
```

### 9.1 Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `v` | integer | yes | Payload schema version. v1 = `1`. |
| `entries` | array | yes | Ordered list of entries in this batch. |

Unknown top-level fields MUST be ignored by readers.

### 9.2 Entry fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | string | yes | `"public"` is the only kind defined in v1. Readers MUST skip entries with an unknown `kind`. |
| `addr` | string | yes | 64-char lowercase hex Autonomi xor-name. |
| `title` | string | yes | 0–256 bytes UTF-8. May be empty. |
| `ts` | integer | yes | Unix seconds (signed 64-bit). |
| `action` | string | yes | One of `"add"`, `"hide"`, `"bookmark"`. |

Unknown entry fields MUST be ignored by readers.

### 9.3 Action semantics

- `add` — assert ownership of an etch the user created. The entry
  becomes visible in the user's chainmark index.
- `bookmark` — assert interest in an etch the user did not necessarily
  create (e.g. someone else's address pasted in). Visible, marked as a
  bookmark by the UI. Functionally equivalent to `add` for replay
  purposes except for the rendering hint.
- `hide` — tombstone. The entry is hidden from the user's chainmark index
  view. The on-chain entry remains permanent.

Encoders MUST emit exactly one of these three values.

### 9.4 Title constraints and warnings

Titles are encrypted at rest on Arbitrum but persist forever. If the
wallet's encryption key is ever recovered (whether via wallet-key
compromise or future cryptanalytic breaks), every title ever synced
becomes readable.

Clients MUST surface a permanence warning to the user before the first
batch is sent. Recommended copy:

> Chainmark entries are stored encrypted on Arbitrum forever. If your
> wallet is ever compromised, every title you have ever synced —
> including hidden ones — becomes readable. Avoid sensitive titles.

## 10. On-chain transaction shape

Each batch is a single Arbitrum One transaction with:

| Field | Value |
|---|---|
| `from` | the wallet's address |
| `to` | the per-tx recipient address derived from the blob's nonce per §3.1 |
| `value` | `0` |
| `data` | the calldata blob (§7) as hex |
| `chainId` | `42161` |
| `gas`, `maxFeePerGas`, `maxPriorityFeePerGas` | wallet defaults; clients MAY estimate via `eth_estimateGas` |

Transactions where `value != 0`, where `to` does not match the §3.1
derivation from the calldata's nonce, or whose calldata fails to decode
(§7) or AEAD-verify (§5) MUST be skipped silently during replay (§11).

## 11. Replay

Given a wallet address `W`:

1. Enumerate all transactions in any block on Arbitrum One where
   `from == W && value == 0`, then keep only those whose `to` matches
   the §3.1 derivation from the calldata nonce. (See §12 on indexers.)
2. Sort ASCENDING by `(block_number, transaction_index)`.
3. For each transaction:
   1. Parse the calldata per §7. On any structural failure, skip.
   2. Decrypt+verify the ciphertext per §5. On AEAD failure, skip.
   3. Decode the plaintext frame per §8. On structural failure, skip.
   4. Parse the JSON payload per §9. On parse failure or `v != 1`,
      skip. (Future-version envelopes MAY be readable by future
      clients; v1 clients MUST skip them.)
   5. For each entry in `entries` left-to-right, apply per §11.1.

### 11.1 Entry application

Maintain an in-memory map `state: addr → {title, ts, action, action_origin}`.

For each entry `e`:
- If `e.action == "add"` or `e.action == "bookmark"`:
  - Set `state[e.addr] = {title: e.title, ts: e.ts, action: e.action, …}`.
- If `e.action == "hide"`:
  - If `state[e.addr]` exists, mark it hidden (preserve title/ts for
    audit; clients SHOULD NOT display hidden entries by default).
  - If `state[e.addr]` does not exist, create a hidden tombstone entry
    so a later `add` can un-hide.

The **last** action seen for a given `addr` (in chain order) wins.
Within a single batch, entries are applied in array order; within a
single block, transactions are applied in `transaction_index` order.

### 11.2 Decryption-skip MUST be silent

Wallets that have unrelated self-send activity (e.g. testing,
non-etchit dapps) will produce calldata that fails AEAD verification.
This is normal. Clients MUST NOT surface these as errors.

## 12. Indexer trust model

Stock JSON-RPC has no method to enumerate self-sends from an address;
clients depend on a third-party indexer (Arbiscan, Routescan,
BlockScout, Alchemy, or a self-hosted equivalent).

The indexer is treated as **untrusted but liveness-relied-upon**:

- An indexer cannot **forge** entries — random calldata will not
  AEAD-decrypt under the user's chainmark index key.
- An indexer can **omit** entries (censorship / staleness).

Clients SHOULD:
- Allow user-overridable indexer URL.
- Warn the user if the highest replayed block is significantly behind
  the chain head.
- Cache replayed state locally so transient indexer outages do not
  blank the chainmark index.

## 13. Versioning

- `version` byte (envelope/crypto): currently `0x01`. Any non-`0x01`
  value MUST be skipped by v1 clients.
- Payload `v` (JSON schema): currently `1`. Any non-`1` value MUST be
  skipped by v1 clients.

### 13.1 Reserved for future versions

- `kind: "private_backup"` — reserved for v2 (per-private-etch
  encrypted backup blob etched publicly to Autonomi, with the
  chainmark entry referencing only the address and a separately
  user-controlled password).
- Argon2id-based KDF — reserved for a future envelope version.
- Additional padding buckets — reserved.

v1 clients MUST gracefully skip entries and envelopes they do not
understand; they MUST NOT crash, error, or display them.

## 14. Privacy properties

Clients MUST surface the following to users in onboarding:

### Already public (no change)
- The wallet's address ↔ public-etch xor-name linkage is already
  visible on-chain via `PaymentVault` calls. The chain/it system does not
  worsen this.

### New on-chain footprint
- Each chainmark tx goes to a fresh per-tx address (§3.1), so chain
  observers cannot enumerate chainmark users with a single `WHERE to = X`
  query. Identifying a tx as ours requires recomputing the §3.1
  derivation against its calldata nonce — cheap per-tx, expensive over
  the full chain.
- The padded-bucket size leaks order-of-magnitude entry counts per
  batch (1 KiB / 4 KiB / 16 KiB — three buckets, finite information).
- Sync timing reveals when batches happen, which a chain observer
  could correlate with `PaymentVault` calls.
- A determined observer can still walk every Arbitrum tx and check the
  derivation per-tx; the design makes this expensive, not impossible.

### Permanence (must warn)
- Every batch is a permanent on-chain artifact.
- Hide is a tombstone, not deletion; the original entry remains
  decryptable forever by anyone with the chainmark index key.
- Forgetting to "Remove from chain/it" before deleting an etch locally
  means a second device restoring the chainmark index will still see the
  reference. UI must distinguish these.

### Off the table (rejected during design)
- A naming registry, an event-only logging contract, or any other
  etchit-deployed-and-operated chain artifact. chain/it has zero
  ongoing operational dependencies on etchit-the-org.

## 15. Test vectors

Every implementation MUST round-trip the following vectors. They are
intentionally minimal to make hand-verification feasible.

### 15.1 KDF vector

Inputs:

```
sign-message (UTF-8, no trailing newline):
  etchit chainmark v1\n\nSign this message to derive your chainmark key. This signature does NOT authorize any transaction or transfer.

personal_sign signature (hex, 65 bytes — example only; substitute your own
when self-testing):
  TBD-ADD-AFTER-FIRST-WALLET-RUN
```

Expected derivation:

- IKM = signature[0..64] (`r || s`).
- HKDF-SHA256(salt=empty, IKM=IKM, info=`"etchit-chainmark/v1/aead-key"`, L=32).

This document will be updated with a fixed signature and expected key
once a stable test wallet is available. Implementations may
self-validate against any RFC 5869 test vector for HKDF-SHA256 in the
meantime.

### 15.2 AEAD + framing vector

```
key       = TBD (32 bytes)
nonce     = 000000000000000000000000  (12 bytes)
plaintext = "0001000000{}\x00...\x00"   (frame: payload_len=12, payload="{\"v\":1,\"entries\":[]}", padding to 1024)
```

Expected `version=0x01, bucket_id=0x00, nonce=…, ciphertext+tag` MUST
match across implementations. Final hex will be added once
ChainmarkCrypto.kt golden tests are written.

### 15.3 Replay vector

A canonical multi-batch replay fixture (add → hide → add) with
hand-encoded JSON and pre-computed ciphertexts will be added under
`docs/chainmark-format-v1.test-vectors.json` once the Kotlin
implementation lands. Cross-client implementations MUST pass it
unchanged.

## 16. Non-goals

- Discoverability (others finding your chainmarks) — out of scope.
- Sharing chainmark indices across wallets — out of scope.
- Mutating individual entries in place — impossible (chain is
  immutable). Mutate via append.
- Compression — out of scope; padding buckets dominate.
- Anonymizing the on-chain footprint — out of scope (would require
  separate infrastructure that conflicts with the no-ongoing-
  responsibility constraint).

## 17. Reference implementations

- `app/src/main/java/com/autonomi/antpaste/chainmark/` — Kotlin (Android), this repository.

Future:
- Rust crate (Linux desktop, Neovim plugin shared backend).
- TypeScript / WebCrypto (web/Electron).

All implementations MUST cross-validate against the test vectors in §15
before being declared v1-conformant.
