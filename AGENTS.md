# TristerFlow delivery workflow

- Do not create pull requests for this repository by default.
- Make changes on a new branch in a new worktree; do not switch the user's active checkout.
- Install dependencies so Husky is active, then run the pre-commit hook and focused release checks.
- Once the change is tested and ready, fast-forward it directly to `main` and push `main`.
- Never force-push.
- Release tags must match the package version. The release workflow requires Developer ID signing and Apple notarization, and publishes only after signature, Gatekeeper, and stapler checks pass.
- Accessibility grants are tied to the app's code-signing requirement: the macOS switch can appear on while `tccd` denies access after the installed app is replaced by a differently signed build. Local `npm run dist` builds without signing credentials are ad-hoc signed; never install one over a working user app. Keep user-facing releases Developer ID-signed/notarized with the same signing identity across updates.
- If the selected-text shortcut repeatedly opens Accessibility settings despite an enabled switch, check `/usr/bin/log show` for `Failed to match existing code requirement` for `ai.pazi.tristrflow`. To repair only this app: quit Tristr Flow, run `tccutil reset Accessibility ai.pazi.tristrflow`, launch the intended build, re-enable its new entry in System Settings, then restart it. Verify with a physical shortcut on selected text and an `Allowed` Accessibility result in `tccd` logs; do not infer success from the switch alone.
- Signed-in ElevenLabs and Fish Audio voices route through the hosted service. A locally saved provider key is an explicit direct-provider override; keep this routing policy centralized in `src/provider-routing.js`.
- Keep the Apple Developer ID G2 intermediate in the exported signing certificate bundle. Store private keys and export passwords only in protected local credential storage and encrypted GitHub Actions secrets; never commit them.
- Keep electron-builder at the workflow's pinned signing version. To recover a failed release, dispatch the release workflow from `main` with the existing tag; it checks out that immutable tag and uses the fixed build tool without retagging.
- Clipboard images must be rebuilt from validated HTTP(S) or embedded raster sources, omit referrers, and stay outside canonical speech text. Never copy image event handlers, srcset, styling, or local file URLs into the overlay.
