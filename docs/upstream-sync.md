## Upstream sync: keep our changes while updating from original repo

This guide shows how to pull the latest changes from the original public repo ("upstream") while keeping our modifications in this fork ("origin"). We generally sync from `upstream/main`. Examples use our `staging` branch.

### One-time setup

```bash
git remote -v
git remote add upstream https://github.com/useautumn/autumn.git   # if not present
git fetch upstream --tags --prune
```

### Quick update (recommended: rebase from upstream/main)

```bash
git checkout staging
git fetch upstream --tags --prune
git branch backup/staging-$(date +%Y%m%d-%H%M%S)
git rebase upstream/main
# resolve conflicts → git add <files> → git rebase --continue (repeat)
# to abort: git rebase --abort
git push origin staging --force-with-lease
```

Then update any feature branches:

```bash
git checkout feature/your-branch
git rebase staging
git push -f origin feature/your-branch
```

Verify you're fully synced with upstream/main:

```bash
git fetch upstream --tags --prune
git log --oneline upstream/main..staging    # should be empty if fully synced
```

### Alternative: merge (no force push, from upstream/main)

```bash
git checkout staging
git fetch upstream --tags --prune
git branch backup/staging-$(date +%Y%m%d-%H%M%S)
git merge --no-ff upstream/main
# resolve conflicts → git add <files> → git commit
git push origin staging
```

### See what will change (optional)

```bash
# commits upstream main has that we don't
git log --oneline staging..upstream/main -n 20

# commits we have that upstream main doesn't (our changes)
git log --oneline upstream/main..staging -n 20

# files changed vs upstream
git diff --name-status upstream/main...staging
```

### Conflict resolution tips

- General
  - Resolve files with conflict markers `<<<<<<<`, `=======`, `>>>>>>>`.
  - Stage resolved files: `git add <file>` then continue: `git rebase --continue` (or finish merge with `git commit`).
  - Prefer small, focused commits to make rebases easier.
  - Enable conflict memory: `git config --global rerere.enabled true`.
  - Strategy options (use carefully):
    - Prefer our side during rebase: `git rebase -X ours upstream/main`
    - Prefer upstream side during rebase: `git rebase -X theirs upstream/main`

- Repo-specific conventions
  - Lockfiles (e.g., `bun.lock`, `package-lock.json`): usually take upstream’s version, then reinstall if needed.
    ```bash
    git checkout --theirs bun.lock
    git add bun.lock
    ```
  - `.gitignore`: usually keep a union of both sides.

### Rollback safely

```bash
git log --oneline -n 5
git reset --hard backup/staging-YYYYMMDD-HHMMSS
git push origin staging --force-with-lease
```

### Verify after syncing

```bash
# local checks
bun install || npm install || yarn
bun run build || npm run build || yarn build
bun run test || npm test || yarn test

# confirm remotes and branch
git remote -v
git status -sb
```

### FAQ

- Are we pushing to the original repo?
  - No. We fetch from `upstream` but push to `origin` (this fork). You would need permission and an explicit `git push upstream ...` to affect the original.

- Which upstream branch should I sync from?
  - Default to `upstream/main`. If the upstream project maintains a separate `staging` with changes not yet in `main`, replace `main` with `staging` in the commands above.

- We have many custom commits—does rebase still work?
  - Yes. Rebase “replays” our commits on top of the newest upstream. Resolve conflicts as they appear and continue.

- How do I see only our custom commits?
  ```bash
  git log --oneline upstream/main..staging
  ```

### Cherry-pick a single upstream commit (targeted fix)

If you only need a specific fix from upstream:

```bash
git checkout staging
git fetch upstream --tags --prune
git cherry-pick -x <upstream-commit-sha>
git push origin staging
```

### Scriptable (optional)

Create a shell script to automate the rebase flow:

```bash
#!/usr/bin/env bash
set -euo pipefail
BRANCH=${1:-staging}
git checkout "$BRANCH"
git fetch upstream --tags --prune
git branch "backup/$BRANCH-$(date +%Y%m%d-%H%M%S)"
git rebase "upstream/$BRANCH"
git push origin "$BRANCH" --force-with-lease
```

Save as `scripts/sync-upstream.sh`, `chmod +x`, and run `./scripts/sync-upstream.sh staging`.


git checkout staging
git branch -m main
git push origin :staging main
git push -u origin main