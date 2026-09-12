# Branches, staging and deploys
How work reaches production, why staging deploys through Actions, and why both
workflows carry repository guards pointing in opposite directions.

## Staging site

`dev` is mirrored to **https://dev.wheretoforage.com** (repo `misherr/wheretoforage-dev`,
remote `preview`). Deploying is one plain push, no force and no follow-up:

```bash
git push preview dev:dev
```

### Why it deploys through Actions

Production and staging need *different* values in the same `CNAME` path
(`wheretoforage.com` vs `dev.wheretoforage.com`). With branch-based publishing
GitHub writes that file into the publishing branch itself, which put a commit on
`preview/dev` that `dev` did not have. Every later deploy then needed
`--force` plus re-asserting the domain, and the branch could never be merged
back toward `main` without pointing production's domain at the staging host.

So staging publishes via `.github/workflows/staging-pages.yml`, which writes
`CNAME` into the *artifact* at build time. The branch stays byte-identical to
`dev`, no CNAME with the wrong value exists in any branch, and `preview` is an
ordinary fast-forward remote.

That workflow lives in the shared tree and will travel to `main` on a merge, so
its job is guarded by `if: github.repository == 'misherr/wheretoforage-dev'`.
**Do not remove that guard** — it is the only thing stopping the production repo
from deploying itself with the staging domain. Production stays on branch-based
Pages (`build_type: legacy`, `main:/`) with its own committed `CNAME`.

### A second push while the first is still deploying fails, and it is not a broken build

Pages allows one in-flight deployment per site. Push twice inside a few minutes
and the second run dies with

> Deployment request failed for `<sha>` due to in progress deployment. Please
> cancel `<earlier sha>` first or wait for it to complete.

It is a 400 from the deployment API, reported as `##[error]Creating Pages
deployment failed`, and it leaves a red X against a commit whose build was
fine — the artifact uploaded, only the deployment was refused. **Re-run the
failed job once the earlier one has finished:**

```bash
gh run rerun <id> --repo misherr/wheretoforage-dev
```

Seen 2026-09-12 with three staging pushes in ten minutes. Nothing to fix in the
workflow: cancelling the in-flight deployment to let a newer one through would
just move the race. If several commits are ready, push them together.

### Both workflows are repository-guarded, in opposite directions

The staging repo is a *full copy* of this tree, so every workflow in
`.github/workflows/` exists on both sides and each one needs to know where it
belongs:

| workflow | runs only on | why |
| --- | --- | --- |
| `weather.yml` | `misherr/wheretoforage` | staging running it too doubles the Open-Meteo spend |
| `staging-pages.yml` | `misherr/wheretoforage-dev` | production deploying it would take its own domain over |

`weather.yml` was unguarded at first and the staging mirror duly ran the
schedule — 465 calls, and it committed the result to its own `dev`, which put a
commit on `preview/dev` that `dev` did not have and broke the fast-forward push.
Any workflow added here needs a guard on one side or the other.

### Where staging gets weather

Staging has no weather job — a second schedule would double the Open-Meteo
spend — so it borrows production's archive over CORS (GitHub Pages serves
`data/weather.json` with `Access-Control-Allow-Origin: *`). Precedence in
`loadWeatherFile()`:

1. **Local, when its grid layout differs from production's.** A dev archive on
   a different layout *is* the thing being staged, so it wins. The comparison
   is a signature over the whole layout, not one stride:
   `2:<LATTICE>/<past.stride>/<forecast.stride>` for a two-grid file,
   `1:<LATTICE>/<STRIDE>` for a single-grid one. A format change counts as a
   difference for exactly the same reason a stride change does. Once production
   catches up the signatures match and this reverts on its own.
2. **Production** otherwise — it is refreshed on schedule, dev's committed copy
   is whatever was last merged and is usually stale.
3. **Local** as the fallback if production is unreachable.

The host guard checks `PROD_HOSTS` first, so adding a subdomain to
`STAGING_HOSTS` can never switch production onto a borrowed file. `localhost`
matches neither and keeps using its own local file.

**The app reads both archive formats**, and has to: while this is staged,
production is still writing single-grid files and staging borrows them. A
single-grid file goes through `ingestOneGrid()` unchanged, with `WBASE` and
`WCOARSE` both set to its one stride so `anchorHit`'s fallback loop runs once.
Deleting that path is only safe once production is on the two-grid format
*and* no borrowed single-grid file can reach a viewer.

## Deployment flow

1. Bake `data/cells.json` with `node scripts/build-cells.mjs` when the habitat
   gate or the vegetation rules change. There is no longer an export button in
   the app, and `PUBLIC_MODE=false` is for local development only.
2. Commit `data/cells.json`, `index.html`, `scripts/`, `.github/` — push.
3. Run the "Update weather" GitHub Action once manually with
   **grids = `past,forecast`** to seed `data/weather.json`; after that the two
   crons run it themselves. Expect the first few days to report anchors still
   to backfill — that is the call ceiling doing its job, not a failure.
4. Set `PUBLIC_MODE=true`, push, serve via GitHub Pages.

See [README.md](../README.md) for full troubleshooting notes (missing
cells.json, connect timeouts, workflow permissions).

## Branch workflow

- `main` is production — GitHub Pages deploys from it, and the weather
  workflow (`weather.yml`) commits `data/weather.json` to it on its own every
  6 hours.
- `dev` is where all day-to-day work happens. Commit there; never push to
  `main` directly unless explicitly told to.
- **Landing a change** (once it's confirmed good): rebase `dev` onto `main`
  first, since `main` accumulates automated `weather.json` commits `dev`
  won't have, then fast-forward `main` and push.
  ```bash
  git checkout dev
  git fetch origin
  git rebase origin/main
  git checkout main
  git merge --ff-only origin/main
  git merge dev
  git push origin main
  git checkout dev
  ```
- **After a rebase, the mirrors need a force.** The rebase step above rewrites
  `dev`'s commits, so `origin/dev` and `preview/dev` still point at the old
  hashes and reject the next push. That is inherent to rebasing, *not* a
  regression of the staging deploy fix — ordinary pushes are fast-forwards.
  Realign both with a lease, never a bare `--force`:
  ```bash
  git fetch preview                       # or the lease check fails on stale info
  git push origin  dev --force-with-lease=refs/heads/dev:<old-sha>
  git push preview dev:dev --force-with-lease=refs/heads/dev:<old-sha>
  ```
  The lease is what caught a real surprise: `preview/dev` had moved under us
  because the staging repo was running its own weather job. Had that been a bare
  `--force`, the commit would have vanished silently and the duplicated spend
  would still be running.
- **Merging `dev` into `main` will conflict on `data/weather.json`** whenever a
  scheduled run has landed, which is often. It is a generated artifact — resolve
  by taking whichever side you mean to ship (`git checkout <sha> -- data/weather.json`),
  never by hand-merging. If in doubt, take the one with the density you intend;
  the next scheduled run rolls it forward regardless.
- **Rolling back a bad deploy**: revert the last commit on `main` and push —
  Pages redeploys automatically. Bring the same revert into `dev` too so it
  doesn't get reintroduced next merge.
  ```bash
  git checkout main
  git pull
  git revert HEAD
  git push origin main
  git checkout dev
  git rebase main
  ```
