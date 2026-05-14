# etch/it desktop

Companion publisher to [`fetch>it`](https://github.com/etchit-io/fetchit).
Tauri 2 + TypeScript / Vite. Reuses fetch>it desktop's brand language,
component conventions, and security posture.

## Status

`0.1.0` — shell only. Six tabs (Etch / Blogger / Website / History /
Wallet / Settings) with placeholder content; Settings has the
functional theme picker. No uploads yet. See
[`../../docs/desktop-roadmap.md`](../../docs/desktop-roadmap.md) for
what's coming and in what order.

## Develop

```bash
cd apps/etchit-desktop
npm install
npm run tauri dev          # launches the app window in dev mode
npm run test:run           # vitest one-shot
npx tsc --noEmit           # type check
```

## Themes

Three: `dark` (brand default), `dim` (warm mid-tone), `light` (bone
canvas). Driven by `body[data-theme="…"]` + CSS custom properties in
`src/styles.css`. Picker lives in Settings; choice persists via
localStorage (key: `etchit-theme`).

## Modular layout

One concern per file, one tab per file. The architecture lock-ins:

| Folder | Holds |
|---|---|
| `src/tabs/` | One mounter per tab; each exports `mountX(host)` and only that. |
| `src/ui/` | Shared widgets (currently just `tabBar.ts`). |
| `src/theme/` | Theme load / apply / persist. Independent of `controller.ts`. |
| `src-tauri/src/` | Tauri 2 backend. No commands yet; added per tab as upload logic lands. |

## License

Dual: AGPL-3.0-only (see [`../../LICENSE`](../../LICENSE)) and a
separate commercial license (see [`../../COMMERCIAL.md`](../../COMMERCIAL.md)).
Matches the relicense applied across the etchit ecosystem.
