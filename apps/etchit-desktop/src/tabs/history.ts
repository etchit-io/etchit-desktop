// History tab — local, read-only log of past etches. Backed by
// `history.json` in the app data dir; entries are written by the upload
// tabs after a successful etch. Nothing here ever hits the network.

import { invoke } from "@tauri-apps/api/core";

import {
  HISTORY_CHANGED_EVENT,
  type HistoryEntry,
  historyClear,
  historyDelete,
  historyLoad,
} from "../history/store";
import { kindLabel, relativeTime, shortAddress } from "../history/format";
import { formatErr } from "../util/error";

interface TabState {
  entries: HistoryEntry[];
  loaded: boolean;
}

export function mountHistory(host: HTMLElement): void {
  host.innerHTML = `
    <div class="history-tab">
      <header class="history-header">
        <div>
          <h1>History</h1>
          <p class="history-lede">
            Every address you&rsquo;ve etched from this device. Local only &mdash;
            this list never goes anywhere.
          </p>
        </div>
        <button type="button" class="history-clear" hidden>Clear history</button>
      </header>

      <p class="history-status" hidden role="status" aria-live="polite"></p>
      <div class="history-empty" hidden>
        <p class="history-empty-headline">No etches yet.</p>
        <p class="history-empty-hint">
          Publish something from <strong>Etch</strong>, <strong>Blogger</strong>,
          or <strong>Website</strong>. Successful etches will appear here.
        </p>
      </div>

      <ul class="history-list" hidden></ul>
    </div>
  `;

  const state: TabState = { entries: [], loaded: false };
  const root = host.querySelector(".history-tab") as HTMLElement;
  const clearBtn = root.querySelector(".history-clear") as HTMLButtonElement;
  const emptyEl = root.querySelector(".history-empty") as HTMLElement;
  const listEl = root.querySelector(".history-list") as HTMLUListElement;
  const statusEl = root.querySelector(".history-status") as HTMLElement;

  const flashStatus = (msg: string): void => {
    statusEl.hidden = false;
    statusEl.textContent = msg;
    window.setTimeout(() => {
      statusEl.hidden = true;
    }, 1600);
  };

  const render = (): void => {
    const empty = state.entries.length === 0;
    emptyEl.hidden = !empty;
    listEl.hidden = empty;
    clearBtn.hidden = empty;
    listEl.innerHTML = "";
    for (const e of state.entries) {
      listEl.appendChild(rowFor(e));
    }
  };

  const rowFor = (entry: HistoryEntry): HTMLLIElement => {
    const li = document.createElement("li");
    li.className = "history-row";
    li.dataset.address = entry.address;
    li.innerHTML = `
      <div class="history-row-main">
        <p class="history-row-label"></p>
        <div class="history-row-meta">
          <span class="history-row-kind"></span>
          <span class="history-row-dot">·</span>
          <span class="history-row-time"></span>
          <span class="history-row-dot">·</span>
          <code class="history-row-addr" title=""></code>
        </div>
      </div>
      <div class="history-row-actions">
        <button type="button" class="history-row-copy" title="Copy address">Copy</button>
        <button type="button" class="history-row-open" title="Open in fetch>it">Open</button>
        <button type="button" class="history-row-delete" title="Remove from history" aria-label="Remove from history">×</button>
      </div>
    `;
    (li.querySelector(".history-row-label") as HTMLElement).textContent = entry.label;
    (li.querySelector(".history-row-kind") as HTMLElement).textContent = kindLabel(entry.kind);
    (li.querySelector(".history-row-time") as HTMLElement).textContent = relativeTime(entry.ts_ms);
    const addrEl = li.querySelector(".history-row-addr") as HTMLElement;
    addrEl.textContent = shortAddress(entry.address);
    addrEl.title = entry.address;

    (li.querySelector(".history-row-copy") as HTMLButtonElement).addEventListener("click", () => {
      void navigator.clipboard.writeText(entry.address).then(
        () => flashStatus("Address copied."),
        () => flashStatus("Couldn't copy to clipboard."),
      );
    });
    (li.querySelector(".history-row-open") as HTMLButtonElement).addEventListener("click", () => {
      void invoke("open_in_fetchit", { address: entry.address }).catch((e: unknown) => {
        flashStatus(formatErr(e));
      });
    });
    (li.querySelector(".history-row-delete") as HTMLButtonElement).addEventListener("click", () => {
      void historyDelete(entry.address).then(
        (next) => {
          state.entries = next;
          render();
        },
        (e: unknown) => flashStatus(formatErr(e)),
      );
    });

    return li;
  };

  clearBtn.addEventListener("click", () => {
    if (!window.confirm("Remove every entry from this list? The addresses stay on the network.")) {
      return;
    }
    void historyClear().then(
      () => {
        state.entries = [];
        render();
        flashStatus("History cleared.");
      },
      (e: unknown) => flashStatus(formatErr(e)),
    );
  });

  const refresh = (): void => {
    void historyLoad().then(
      (entries) => {
        state.entries = entries;
        state.loaded = true;
        render();
      },
      (e: unknown) => {
        state.loaded = true;
        flashStatus(`Couldn't load history: ${formatErr(e)}`);
        render();
      },
    );
  };

  window.addEventListener(HISTORY_CHANGED_EVENT, refresh);
  refresh();
}
