# Porteau

Porteau is a safety-first TypeScript CLI over mydumper and myloader.
Use Vite+ with the pnpm version pinned in `package.json`; do not use npm or Corepack.
Run the CLI locally with `vp run porteau <arguments>`.
Run `vp check`, `vp test`, and `vp pack` before finishing code changes.

## Safe alpha releases

1. Land changes on `main` with green CI (`Node 22.18.0`, `Node 24`).
2. Keep `package.json` version and generated `install.sh` in sync (`vp run bump <semver>`).
3. Create an **annotated** tag only: `git tag -a vX.Y.Z-alpha.N -m "Release vX.Y.Z-alpha.N"`.
4. Push the tag once. Do **not** force-move a tag after npm has accepted that version.
5. Release workflow (`.github/workflows/release.yml`) must:
   - run only on this repository (not forks)
   - validate tag ↔ version ↔ `main` ancestry ↔ green CI
   - publish to npm via **trusted publishing OIDC** (no `NPM_TOKEN`), with provenance, `--ignore-scripts`, and dist-tag `next` (never `latest` for alphas)
   - attach both `install.sh` and `porteau.tgz` to a verified GitHub prerelease, then smoke the public installer URL

### npm Trusted Publisher (required, one-time)

No long-lived `NPM_TOKEN`. Configure OIDC once, then tag pushes publish.

On https://www.npmjs.com/package/porteau → **Access** → **Trusted Publishers** → **GitHub Actions**:

- Repository: `SebastiaanWouters/porteau`
- Workflow filename: `release.yml`
- Environment: leave empty
- Allow: publish

Or from a logged-in maintainer machine:

```sh
npm trust github porteau --file release.yml --repo SebastiaanWouters/porteau --allow-publish -y
```
