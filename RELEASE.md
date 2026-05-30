# Releasing Word Circles

The frontend (Vercel) and backend (DAppNode) deploy on **different clocks** — the
frontend in seconds, the backend through a slow image → IPFS → sideload path. They
are intentionally **decoupled at runtime** so "out of sync" is a safe, visible
state rather than a broken app, and you never have to land them at the same time.

## The decoupling rules

1. **The backend owns feature availability.** PvP is gated solely by the backend's
   `PVP_ENABLED`, which the frontend reads at runtime from `/api/config`
   (`pvpEnabled`). There is **no frontend build-time flag** — the PvP UI ships dark
   and lights up the moment the backend flips the flag, with no Vercel rebuild.
   See `src/lib/usePvpEnabled.ts`.

2. **The FE/BE contract is drift-checked.** `src/lib/api/openapi.json` is generated
   from the backend (`make openapi`) and the frontend's TS types come from it. CI's
   `openapi-drift` job regenerates it and fails on diff, so a backend handler change
   can't ship a frontend built against a stale contract. **After changing any API
   handler/schema, run `make openapi` and commit the result.**

3. **The frontend does not auto-promote to production** (see setup below). Push to
   `main` → Vercel **preview**. You promote to production manually once the backend
   it depends on is live.

Net effect: merge frontend code to `main` freely (it lands on preview, dark),
release the backend on its own slow cadence, and **flip the backend flag** to light
the feature up — the frontend follows automatically.

## Frontend release (Vercel)

Push to `main` builds a **preview** deployment. To go live:

1. Open the deployment in the Vercel dashboard (or `vercel ls`).
2. Verify it against the current production backend.
3. **Promote to Production** (dashboard → deployment → ⋯ → Promote, or
   `vercel promote <deployment-url>`).

### One-time setup: stop auto-promoting `main` to production

This is a **Vercel project setting**, not a repo file (there is no `vercel.json`
key for "build `main` as preview but require manual promotion"):

> Project → Settings → Git → **Production Branch**: set to a branch you do **not**
> push day-to-day (e.g. `production`), leaving `main` to produce preview
> deployments. Promote by fast-forwarding `production` to the reviewed commit, or
> by promoting the preview deployment directly in the dashboard.

## Backend release (DAppNode)

The backend image and the DAppNode package are pinned to a version; bump it
**before** tagging.

1. Bump `deployment/dappnode_package.json` `version`, and update
   `deployment/api/Dockerfile`'s `FROM bh2smith/word-circles-backend:<version>` to
   the same version. Commit.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. CI (`docker-publish.yml`) then:
   - builds & pushes the backend image to Docker Hub + GHCR, and
   - builds the DAppNode `.xz` (`dappnode-package` job, checks the tag matches the
     package version) and attaches it to the GitHub Release.
4. **Manual (cannot run in CI):** download the `.xz` from the Release, upload it to
   IPFS, and sideload it through the DAppNode admin UI. See `deployment/README.md`.

## Turning PvP on (no deploy)

Once the PvP backend is live, set `PVP_ENABLED=true` (plus `PVP_TOKEN`,
`PVP_AMOUNT`, etc.) in the DAppNode package config. The frontend's PvP nav + route
appear automatically on next `/api/config` read — no Vercel rebuild or promote.
