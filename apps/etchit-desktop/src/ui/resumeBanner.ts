// SPDX-License-Identifier: AGPL-3.0-only
// Global "Unfinished etch" banner — surfaces any pending finalize so
// the user can retry it (or discard the record after they've decided
// the on-chain payment is lost). One row per pending entry; rows
// vanish on success because `resumePending` clears the record and we
// re-render off the change event.
//
// Lives at the top of the document below the wallet-action banner;
// stays visible as the user switches tabs (the pending state is
// app-wide). Same-session only — pending records live in memory and
// are gone after a restart.

import { ask } from "@tauri-apps/plugin-dialog";

import { formatErr } from "../util/error";
import {
  clearPending,
  listPending,
  onPendingChange,
  type PendingEtch,
  resumePending,
} from "../wallet/pendingEtches";

let stackEl: HTMLDivElement | null = null;
const inFlight = new Set<string>();
const errors = new Map<string, string>();

// Happy-path finalizes usually return in <1 s — without a delay the
// banner flashes onto the page and back off for every successful
// etch, which reads as "something broke". Hold rendering of a pending
// entry until it's been around long enough to genuinely look stuck.
const SHOW_AFTER_MS = 4000;
const showTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Mount the global banner once. Idempotent. */
export function mountResumeBanner(): void {
  if (stackEl) return;
  const el = document.createElement("div");
  el.className = "resume-banner-stack";
  el.setAttribute("role", "alert");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;
  document.body.appendChild(el);
  stackEl = el;

  onPendingChange(render);
  render();
}

function render(): void {
  if (!stackEl) return;
  const now = Date.now();
  const pending = listPending();
  const pendingIds = new Set(pending.map((p) => p.id));

  // Cancel any pending-show timers for entries that have already
  // resolved; clean their cached error state too.
  for (const [id, timer] of showTimers) {
    if (!pendingIds.has(id)) {
      clearTimeout(timer);
      showTimers.delete(id);
    }
  }
  for (const id of [...errors.keys()]) {
    if (!pendingIds.has(id)) errors.delete(id);
  }

  // Only entries that have been pending long enough are visible.
  // Schedule a re-render for any that are still inside the cool-down.
  const visible: PendingEtch[] = [];
  for (const entry of pending) {
    const age = now - entry.createdAt;
    if (age >= SHOW_AFTER_MS) {
      visible.push(entry);
      continue;
    }
    if (!showTimers.has(entry.id)) {
      const timer = setTimeout(() => {
        showTimers.delete(entry.id);
        render();
      }, SHOW_AFTER_MS - age);
      showTimers.set(entry.id, timer);
    }
  }

  stackEl.hidden = visible.length === 0;
  stackEl.replaceChildren();
  for (const entry of visible) {
    stackEl.appendChild(rowFor(entry));
  }
}

function rowFor(entry: PendingEtch): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "resume-banner-row";
  row.dataset.id = entry.id;
  const busy = inFlight.has(entry.id);
  const flowLabel = entry.flow.type === "private" ? "private etch" : "etch";

  const body = document.createElement("div");
  body.className = "resume-banner-body";
  body.innerHTML = `
    <p class="resume-banner-headline">Unfinished ${escapeHtml(flowLabel)}: <strong class="resume-banner-label"></strong></p>
    <p class="resume-banner-hint">Payment cleared but finalize never returned — retry to deliver the chunks.</p>
  `;
  (body.querySelector(".resume-banner-label") as HTMLElement).textContent =
    entry.label || "Untitled";

  const err = errors.get(entry.id);
  if (err) {
    const errEl = document.createElement("p");
    errEl.className = "resume-banner-error";
    errEl.textContent = err;
    body.appendChild(errEl);
  }

  const actions = document.createElement("div");
  actions.className = "resume-banner-actions";

  const resumeBtn = document.createElement("button");
  resumeBtn.type = "button";
  resumeBtn.className = "resume-banner-resume";
  resumeBtn.textContent = busy ? "Resuming…" : "Resume";
  resumeBtn.disabled = busy;
  resumeBtn.addEventListener("click", () => {
    void onResume(entry);
  });

  const discardBtn = document.createElement("button");
  discardBtn.type = "button";
  discardBtn.className = "resume-banner-discard";
  discardBtn.textContent = "Discard";
  discardBtn.disabled = busy;
  discardBtn.addEventListener("click", () => {
    void onDiscard(entry);
  });

  actions.append(resumeBtn, discardBtn);
  row.append(body, actions);

  return row;
}

async function onResume(entry: PendingEtch): Promise<void> {
  inFlight.add(entry.id);
  errors.delete(entry.id);
  render();
  try {
    await resumePending(entry.id);
    // success: clearPending fires the change event which removes the row.
  } catch (e) {
    errors.set(entry.id, formatErr(e));
  } finally {
    inFlight.delete(entry.id);
    render();
  }
}

async function onDiscard(entry: PendingEtch): Promise<void> {
  const ok = await ask(
    [
      "Discard this unfinished etch?",
      "",
      `The on-chain payment (tx ${entry.payTxHash.slice(0, 14)}…) has already cleared and can't be refunded — discarding only stops etch/it from trying to complete the upload.`,
      "",
      "Continue?",
    ].join("\n"),
    { title: "Discard unfinished etch", kind: "warning" },
  );
  if (!ok) return;
  clearPending(entry.id);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
