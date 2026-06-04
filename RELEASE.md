# Releasing Word Circles

The frontend (Vercel) and backend (DAppNode) deploy on **different clocks** — the
frontend in seconds, the backend through a slow image → IPFS → sideload path. They
are intentionally **decoupled at runtime** so "out of sync" is a safe, visible
state rather than a broken app, and you never have to land them at the same time.

## The decoupling rules

1. **Both sides must opt in to PvP.** The PvP UI only appears when the frontend was
   built with `NEXT_PUBLIC_PVP_ENABLED=true` **and** the backend reports `pvpEnabled`
   at runtime (from `PVP_ENABLED`, read via `/api/config`) — and then only for a
   player who's a member of a configured lobby. Either side can hold PvP back
   independently: the backend flag is runtime (flip it with no rebuild), while the
   frontend flag is inlined at build (`NEXT_PUBLIC_*`), so changing it needs a Vercel
   rebuild. See `src/lib/usePvpEnabled.ts` and `src/lib/usePvpLobbies.ts`.

2. **The FE/BE contract is drift-checked.** `src/lib/api/openapi.json` is generated
   from the backend (`make openapi`) and the frontend's TS types come from it. CI's
   `openapi-drift` job regenerates it and fails on diff, so a backend handler change
   can't ship a frontend built against a stale contract. **After changing any API
   handler/schema, run `make openapi` and commit the result.**

3. **The frontend does not auto-promote to production** (see setup below). Push to
   `main` → Vercel **preview**. You promote to production manually once the backend
   it depends on is live.

Net effect: merge frontend code to `main` freely (it lands on preview, dark —
double-dark until the build has `NEXT_PUBLIC_PVP_ENABLED=true`), release the backend
on its own slow cadence, and light the feature up by turning on **both** flags — the
backend's `PVP_ENABLED` (runtime) and the frontend's `NEXT_PUBLIC_PVP_ENABLED`
(rebuild). Either one off keeps PvP dark.

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

1. Bump `deployment/dappnode_package.json` (`version` **and** `upstreamVersion`),
   and update `deployment/api/Dockerfile`'s `FROM bh2smith/word-circles-backend:<version>`
   to the same version. Commit. (The `bump-version` skill does this in place; the
   `prepare-release` skill does it as a standalone PR.)
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. CI (`docker-publish.yml`) then:
   - builds & pushes the backend image to Docker Hub + GHCR, and
   - builds the DAppNode `.xz` (`dappnode-package` job, checks the tag matches the
     package version) and attaches it to the GitHub Release.
4. **Manual (cannot run in CI):** download the `.xz` from the Release, upload it to
   IPFS, and sideload it through the DAppNode admin UI. See `deployment/README.md`.

## Turning PvP on

PvP needs **both** opt-ins (see decoupling rule 1):

1. **Backend (runtime, no deploy):** in the DAppNode package config set
   `PVP_ENABLED=true` and configure `PVP_LOBBIES` (JSON array, one entry per Circles
   group) plus `GROUP_ADDRESS` (onboarding group). Reflected on the next
   `/api/config` read — no Vercel rebuild. See `docs/multi-group-pvp.md` for the
   `PVP_LOBBIES` shape.
2. **Frontend (build-time):** the production build must have
   `NEXT_PUBLIC_PVP_ENABLED=true`. Because `NEXT_PUBLIC_*` is inlined at build, this
   needs a Vercel rebuild/redeploy if it wasn't already set.

With both on, the PvP nav + routes appear for members of a configured lobby. For the
fastest kill switch, flip the backend's `PVP_ENABLED=false` (runtime — no rebuild).
