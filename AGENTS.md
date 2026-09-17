# TristerFlow delivery workflow

- Do not create pull requests for this repository by default.
- Make changes on a new branch in a new worktree; do not switch the user's active checkout.
- Install dependencies so Husky is active, then run the pre-commit hook and focused release checks.
- Once the change is tested and ready, fast-forward it directly to `main` and push `main`.
- Never force-push.
- Release tags must match the package version. The release workflow requires Developer ID signing and Apple notarization, and publishes only after signature, Gatekeeper, and stapler checks pass.
- Signed-in ElevenLabs and Fish Audio voices route through the hosted service. A locally saved provider key is an explicit direct-provider override; keep this routing policy centralized in `src/provider-routing.js`.
- Keep the Apple Developer ID G2 intermediate in the exported signing certificate bundle. Store private keys and export passwords only in protected local credential storage and encrypted GitHub Actions secrets; never commit them.
- Keep electron-builder at the workflow's pinned signing version. To recover a failed release, dispatch the release workflow from `main` with the existing tag; it checks out that immutable tag and uses the fixed build tool without retagging.
