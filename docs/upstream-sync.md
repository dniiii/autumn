## Upstream sync: keep our changes while updating from original repo

This guide shows how to pull the latest changes from the original public repo ("upstream") while keeping our modifications in this fork ("origin"). Examples use the `staging` branch; swap for `main` if needed.

### One-time setup

```bash
git remote -v
git remote add upstream https://github.com/useautumn/autumn.git   # if not present
git fetch upstream --tags --prune
```

### Quick update (recommended: rebase)

```bash
git checkout staging
git fetch upstream --tags --prune
git branch backup/staging-$(date +%Y%m%d-%H%M%S)
git rebase upstream/staging
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

### Alternative: merge (no force push)

```bash
git checkout staging
git fetch upstream --tags --prune
git branch backup/staging-$(date +%Y%m%d-%H%M%S)
git merge --no-ff upstream/staging
# resolve conflicts → git add <files> → git commit
git push origin staging
```

### See what will change (optional)

```bash
# commits upstream has that we don't
git log --oneline staging..upstream/staging -n 20

# commits we have that upstream doesn't (our changes)
git log --oneline upstream/staging..staging -n 20

# files changed vs upstream
git diff --name-status upstream/staging...staging
```

### Conflict resolution tips

- General
  - Resolve files with conflict markers `<<<<<<<`, `=======`, `>>>>>>>`.
  - Stage resolved files: `git add <file>` then continue: `git rebase --continue` (or finish merge with `git commit`).
  - Prefer small, focused commits to make rebases easier.
  - Enable conflict memory: `git config --global rerere.enabled true`.
  - Strategy options (use carefully):
    - Prefer our side during rebase: `git rebase -X ours upstream/staging`
    - Prefer upstream side during rebase: `git rebase -X theirs upstream/staging`

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

- What if upstream’s default branch is `main`?
  - Replace `staging` with `main` in commands.

- We have many custom commits—does rebase still work?
  - Yes. Rebase “replays” our commits on top of the newest upstream. Resolve conflicts as they appear and continue.

- How do I see only our custom commits?
  ```bash
  git log --oneline upstream/staging..staging
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


