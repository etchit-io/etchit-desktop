// Passphrase modal — used by both export (generate / write down) and
// import (enter existing) flows for the password-encrypted backup.
//
// Two modes:
//   "create"  → auto-generates a 6-word diceware passphrase, lets the
//               user copy / replace it, and confirms they've saved it.
//   "enter"   → just a passphrase field; user types the 6 words they
//               wrote down on the originating device (or their custom
//               password).
//
// Resolves to the chosen password string, or `null` if cancelled.

import { generatePassphrase } from "./passphrase";

export type BackupModalMode = "create" | "enter";

export function openBackupModal(mode: BackupModalMode): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "backup-modal-overlay";
    overlay.innerHTML = `
      <div class="backup-modal" role="dialog" aria-modal="true">
        <header class="backup-modal-header">
          <h2></h2>
          <button type="button" class="backup-modal-close" aria-label="Close">×</button>
        </header>
        <p class="backup-modal-lede"></p>
        <div class="backup-modal-warn">
          <strong>Permanence:</strong> if you lose this passphrase, every
          private etch in the backup is unrecoverable. The encrypted
          chunks stay on the network forever, but no one — including
          you — can ever decrypt them again.
        </div>
        <label class="backup-modal-label">
          <span class="backup-modal-label-text"></span>
          <input class="backup-modal-input" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" />
        </label>
        <button type="button" class="backup-modal-regen" hidden>Generate another</button>
        <div class="backup-modal-actions">
          <button type="button" class="backup-modal-cancel">Cancel</button>
          <button type="button" class="backup-modal-confirm"></button>
        </div>
      </div>
    `;

    const title = overlay.querySelector(".backup-modal-header h2") as HTMLElement;
    const lede = overlay.querySelector(".backup-modal-lede") as HTMLElement;
    const labelText = overlay.querySelector(".backup-modal-label-text") as HTMLElement;
    const input = overlay.querySelector(".backup-modal-input") as HTMLInputElement;
    const regenBtn = overlay.querySelector(".backup-modal-regen") as HTMLButtonElement;
    const confirmBtn = overlay.querySelector(".backup-modal-confirm") as HTMLButtonElement;
    const cancelBtn = overlay.querySelector(".backup-modal-cancel") as HTMLButtonElement;
    const closeBtn = overlay.querySelector(".backup-modal-close") as HTMLButtonElement;

    if (mode === "create") {
      title.textContent = "Export private library";
      lede.textContent =
        "Six BIP-39 words → 66 bits of entropy. Write them down or paste into a password manager before continuing. Anyone with this passphrase plus your wallet can decrypt the backup.";
      labelText.textContent = "Passphrase";
      input.value = generatePassphrase();
      regenBtn.hidden = false;
      confirmBtn.textContent = "Save backup…";
    } else {
      title.textContent = "Import private library";
      lede.textContent =
        "Enter the passphrase you wrote down when exporting. Six BIP-39 words separated by hyphens, or whatever custom password you used.";
      labelText.textContent = "Passphrase";
      input.value = "";
      regenBtn.hidden = true;
      confirmBtn.textContent = "Decrypt";
    }

    const settle = (value: string | null): void => {
      document.body.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") settle(null);
      if (e.key === "Enter" && document.activeElement === input) {
        confirmBtn.click();
      }
    };

    regenBtn.addEventListener("click", () => {
      input.value = generatePassphrase();
      input.focus();
      input.select();
    });
    confirmBtn.addEventListener("click", () => {
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return;
      }
      settle(v);
    });
    cancelBtn.addEventListener("click", () => settle(null));
    closeBtn.addEventListener("click", () => settle(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) settle(null);
    });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}
