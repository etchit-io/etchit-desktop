// Password modal — the single UX entry point for "I need the
// session password right now". Two flavours:
//
//   "create" → first time on this device. Auto-generates a 6-word
//              BIP-39 passphrase; user can regenerate, replace with a
//              custom password, and must explicitly confirm they've
//              saved it. Resolves to the chosen password string.
//   "enter"  → later opens / restores / backups. Single field; the
//              caller validates by attempting to decrypt.
//
// Resolves to the entered password (string) or `null` if the user
// cancels / closes the modal. Caller is responsible for calling
// `setSessionPassword` after a successful decrypt — that way wrong
// passwords don't poison the session cache.

import { generatePassphrase } from "./passphrase";

export type PasswordModalMode = "create" | "enter";

export function openPasswordModal(mode: PasswordModalMode): Promise<string | null> {
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
        <div class="backup-modal-warn" hidden>
          <strong>Lose this passphrase, lose every private etch.</strong>
          The encrypted chunks stay on the network forever, but no one —
          including you — can ever decrypt them again. Save it somewhere
          you trust before you continue.
        </div>
        <label class="backup-modal-label">
          <span class="backup-modal-label-text">Passphrase</span>
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
    const warn = overlay.querySelector(".backup-modal-warn") as HTMLElement;
    const input = overlay.querySelector(".backup-modal-input") as HTMLInputElement;
    const regenBtn = overlay.querySelector(".backup-modal-regen") as HTMLButtonElement;
    const confirmBtn = overlay.querySelector(".backup-modal-confirm") as HTMLButtonElement;
    const cancelBtn = overlay.querySelector(".backup-modal-cancel") as HTMLButtonElement;
    const closeBtn = overlay.querySelector(".backup-modal-close") as HTMLButtonElement;

    if (mode === "create") {
      title.textContent = "Set a passphrase for private etches";
      lede.textContent =
        "Private etches are encrypted with a passphrase you choose. Same passphrase unlocks them on every device.";
      warn.hidden = false;
      input.value = generatePassphrase();
      regenBtn.hidden = false;
      confirmBtn.textContent = "Save & continue";
    } else {
      title.textContent = "Enter your private-etch passphrase";
      lede.textContent =
        "The same passphrase you set when you first made a private etch on this library.";
      warn.hidden = true;
      input.value = "";
      regenBtn.hidden = true;
      confirmBtn.textContent = "Unlock";
    }

    const settle = (value: string | null): void => {
      document.body.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") settle(null);
      if (e.key === "Enter" && document.activeElement === input) confirmBtn.click();
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
