# TristerFlow delivery workflow

- Do not create pull requests for this repository by default.
- Make changes on a new branch in a new worktree; do not switch the user's active checkout.
- Install dependencies so Husky is active, then run the pre-commit hook and focused release checks.
- Once the change is tested and ready, fast-forward it directly to `main` and push `main`.
- Never force-push.
