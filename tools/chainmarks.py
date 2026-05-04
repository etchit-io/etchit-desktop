#!/usr/bin/env python3
"""
List your etchit chainmarks on any machine.

    pip install cryptography     # or: apt install python3-cryptography
    python3 chainmarks.py <wallet-address>          # prompts for key (no echo)
    python3 chainmarks.py <wallet-address> -        # read key from stdin (one line)

Reads BlockScout for the wallet's Arbitrum tx history, decrypts each
chainmark batch with the supplied AES-256-GCM key, replays add/bookmark/
hide actions, and prints the visible entries with the matching
ant-cli download command per entry.

The key is never read from argv (would land in shell history + `ps`).
Get it from the mobile app: Settings → chain/it → Back up chainmark key.

Spec: ../docs/chainmark-format-v1.md (sections 3.1, 4-11). Cross-impl
test vector: this file is independent from the Kotlin implementation
and round-trips through the same wire format.
"""
import getpass
import hashlib
import json
import re
import sys
import urllib.request

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

INDEXER_BASE = "https://arbitrum.blockscout.com/api"
RECIPIENT_PREFIX = b"etchit-chainmark-v1/recipient"
VERSION_BYTE = 0x01
NONCE_LEN = 12
TAG_LEN = 16
BUCKETS = (1024, 4096, 16384)


def recipient_for_blob(blob: bytes) -> str:
    nonce = blob[2:2 + NONCE_LEN]
    return "0x" + hashlib.sha256(RECIPIENT_PREFIX + nonce).digest()[12:32].hex()


def open_blob(key: bytes, blob: bytes) -> bytes | None:
    if len(blob) < 2 + NONCE_LEN + TAG_LEN:
        return None
    if blob[0] != VERSION_BYTE:
        return None
    bucket_id = blob[1]
    if bucket_id not in (0, 1, 2):
        return None
    bucket_size = BUCKETS[bucket_id]
    if len(blob) != 2 + NONCE_LEN + bucket_size + TAG_LEN:
        return None
    nonce = blob[2:2 + NONCE_LEN]
    ct = blob[2 + NONCE_LEN:]
    try:
        frame = AESGCM(key).decrypt(nonce, ct, None)
    except Exception:
        return None
    payload_len = int.from_bytes(frame[0:4], "little")
    if 4 + payload_len > bucket_size:
        return None
    return frame[4:4 + payload_len]


def fetch_txs(wallet: str) -> list[dict]:
    url = f"{INDEXER_BASE}?module=account&action=txlist&address={wallet}&sort=asc"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read()).get("result") or []


def replay(wallet: str, key: bytes) -> list[dict]:
    from_filter = wallet.lower()
    candidates = []
    for tx in fetch_txs(wallet):
        if tx.get("from", "").lower() != from_filter:
            continue
        if tx.get("value") != "0":
            continue
        inp = tx.get("input", "")
        if not inp or inp == "0x":
            continue
        try:
            blob = bytes.fromhex(inp.removeprefix("0x"))
        except ValueError:
            continue
        if len(blob) < 14 or blob[0] != VERSION_BYTE:
            continue
        if tx.get("to", "").lower() != recipient_for_blob(blob).lower():
            continue
        plaintext = open_blob(key, blob)
        if plaintext is None:
            continue
        try:
            payload = json.loads(plaintext.decode("utf-8"))
        except Exception:
            continue
        if payload.get("v") != 1:
            continue
        candidates.append((
            int(tx.get("blockNumber", "0")),
            int(tx.get("transactionIndex", "0")),
            payload,
        ))
    candidates.sort(key=lambda c: (c[0], c[1]))

    state: dict[str, dict] = {}
    for _, _, payload in candidates:
        for entry in payload.get("entries", []):
            if entry.get("kind") != "public":
                continue
            addr = entry.get("addr", "")
            if not re.fullmatch(r"[0-9a-f]{64}", addr):
                continue
            action = entry.get("action")
            title = entry.get("title", "")
            ts = entry.get("ts", 0)
            if action in ("add", "bookmark"):
                state[addr] = {
                    "addr": addr, "title": title, "ts": ts,
                    "bookmark": action == "bookmark", "hidden": False,
                }
            elif action == "hide":
                if addr in state:
                    state[addr]["hidden"] = True
                else:
                    state[addr] = {
                        "addr": addr, "title": "", "ts": 0,
                        "bookmark": False, "hidden": True,
                    }
    return list(state.values())


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print(f"usage: {sys.argv[0]} <wallet-address> [-]", file=sys.stderr)
        print("       (key is prompted with no echo; use '-' to read it from stdin)", file=sys.stderr)
        return 2
    wallet = sys.argv[1].strip()
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", wallet):
        print(f"invalid wallet address: {wallet}", file=sys.stderr)
        return 1

    if len(sys.argv) == 3 and sys.argv[2] == "-":
        key_hex = sys.stdin.readline().strip().removeprefix("0x")
    else:
        key_hex = getpass.getpass("chainmark key (hex, no echo): ").strip().removeprefix("0x")

    if not re.fullmatch(r"[0-9a-fA-F]{64}", key_hex):
        print(f"invalid chainmark key (need 64 hex chars, got {len(key_hex)})", file=sys.stderr)
        return 1

    entries = replay(wallet, bytes.fromhex(key_hex))
    visible = [e for e in entries if not e["hidden"]]
    if not visible:
        print("(empty chain/it)")
        return 0
    for e in visible:
        marker = "★" if e["bookmark"] else " "
        title = e["title"] or "Untitled"
        # Filename for `ant file download --output`: sanitised title, falling back
        # to an address prefix. Keeps shell-safe chars only.
        safe = re.sub(r"[^a-zA-Z0-9._-]", "_", title)[:50] or e["addr"][:10]
        print(f"{marker} {title}")
        print(f"  {e['addr']}")
        print(f"  ant file download --output {safe} {e['addr']}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
