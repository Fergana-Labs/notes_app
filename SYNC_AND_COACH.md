# Mochi — Sync, Coach, and AI Tags

This branch (`mochi-sync-coach`) turns Mochi from a purely local notebook into the
**desktop half of a synced, AI-assisted system** shared with the mobile app
(`../stash_app`). Three pieces landed here, plus a clipboard bug fix.

> ⚠️ **The Rust was written but not compiled in the environment that produced
> it** (no Rust toolchain there). Run `cargo build` / `cargo test` from
> `src-tauri/` and expect to fix a few small things. The TypeScript frontend
> typechecks clean (`npx tsc --noEmit`).

---

## How it fits together

The **relay** (an Express server in `../stash_app/server`) is the hub. Mochi
(desktop) and the phone are both clients of it:

```
   Mochi (this app) ─┐
                     ├─▶  Relay  ◀── Phone (stash_app)
                     │    • sync op log (store-and-forward)
                     │    • audio clips
                     │    • coach agent (Claude, shared per workspace)
                     │    • AI tagger (adds ai_tags to new notes)
```

Desktop is the **workspace owner**: it pairs with the relay (minting a workspace)
and shows a pairing payload the phone scans. Everything converges through the
same op protocol, so a note typed on the desktop shows up on the phone and vice
versa.

---

## 1. Sync (M5) — `src-tauri/src/sync/`

A Rust port of the mobile offline-first engine (`../stash_app/app/src/sync`).
Same wire protocol, **HLC** clock rules, and **last-write-wins** conflict
resolution, so the two sides converge identically.

| File | What it does |
|---|---|
| `hlc.rs` | Hybrid logical clock (wall/counter/origin total order) |
| `wire.rs` | Op + block/tag/daily payloads (serde) |
| `oplog.rs` | Local op recording + push/pull cursors |
| `reconcile.rs` | **Capture by diffing** current rows vs a `sync_shadow` of per-row signatures |
| `apply.rs` | Apply remote ops with LWW + idempotency; refresh the shadow (echo suppression) |
| `client.rs` | Async push/pull cycle over `reqwest` |
| `commands.rs` | Tauri commands: `sync_pair` / `sync_status` / `sync_unpair` / `sync_tick` |

**Why reconcile-diff instead of write-through?** The desktop has out-of-band
writers — the user editing, *and agents writing `blocks.db` directly*. Rather
than recording an op on every edit (which would miss agent writes), each sync
cycle diffs the current rows against `sync_shadow` and emits ops for whatever
changed. `apply` updates the shadow as it writes, so a change pulled from the
relay isn't echoed back as a local one. `save_snapshot` is left untouched.

A background `tokio` task (spawned in `lib.rs`) runs a sync cycle every few
seconds; it's a no-op until a workspace is open and paired.

**Pairing UI:** sidebar → **Sync**. It shows `{ url, workspace_id, token }` —
the exact JSON the phone's QR scanner reads. (A QR component, e.g.
`qrcode.react`'s `QRCodeSVG`, can wrap that payload; it's shown as copyable text
for now because the dependency couldn't be installed where this was built.)

Schema is **additive** (`sync_meta`, `sync_oplog`, `sync_row_meta`,
`applied_ops`, `sync_state`, `sync_shadow`) — existing workspaces are unaffected.

**Tests:** `src-tauri/src/sync/tests.rs` (run `cargo test`) covers capture →
apply, two-device convergence, LWW on concurrent edits, and echo suppression.

---

## 2. Coach + AI tags (M6)

**Coach** (sidebar → **Coach**): a thin chat UI over the relay's shared coach
agent — the *same* agent and history the phone talks to. It reads the relay URL
+ token from sync status and calls the relay's `/coach/messages` endpoints. The
agent reasons over your synced notes and can add notes (which sync back here).
"Think" toggles a deeper (Opus) mode. No LLM runs in Mochi — it's a UI.

**AI-recommended tags:** the relay's tagger suggests tags for new notes and marks
them `ai_tags` on the synced block payload. On the desktop:

- `apply.rs` persists `ai_tags` into a new `block_ai_tags` table.
- `db.rs` projects them onto `StoredBlock.ai_tags` (only tags that are still real
  tags on the block).
- `BlockView.tsx` renders AI tags distinctly (✨, amber) with a **×** to remove
  one — `remove_tag_from_block` (new Tauri command in `commands.rs`) drops just
  that block's edge; the change syncs out and the tag stays in the global list.

---

## 3. Daily-note clipboard fix (M7)

`src/editor/extensions/ClipboardSerialize.ts` → `sliceToMarkdown` used to strip
trailing whitespace, drop empty serialized chunks, and join rows with a single
newline — so **blank lines and empty bullets were lost on copy and adjacent
paragraphs merged**. It now keeps empty chunks (blank paragraphs / empty list
items survive) and joins block-level nodes with a blank line so paragraphs stay
distinct. Round-trips correctly both between notes and into external editors.

---

## Building & verifying

```sh
# Rust (the part to verify):
cd src-tauri && cargo build && cargo test

# Frontend:
npm install        # (qrcode.react optional, for the pairing QR)
npx tsc --noEmit
npm run tauri dev

# End to end: start the relay (../stash_app/server: npm run dev), open Mochi,
# sidebar → Sync → Pair, scan/enter the payload on the phone, then edit on each
# and watch them converge. Coach + AI tags require ANTHROPIC_API_KEY on the relay.
```

See `../stash_app` (branch `voice-journal-coach`) for the relay, the coach agent,
the AI tagger, audio clips, and the mobile client.
