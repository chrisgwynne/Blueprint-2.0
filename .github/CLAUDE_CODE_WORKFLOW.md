# Blueprint — Claude Code Issue Workflow

This is the operating agreement between Claude Code and this repository.
Every piece of non-trivial work follows this flow: a GitHub Issue exists
first, then a branch, then a PR that references the issue, then a merge.
Nothing is done on `main` directly, and nothing ships untracked.

---

## Branch strategy

- **`main`** — always stable, always releasable. Every commit on `main`
  is tagged or ready to be. Only release PRs merge here.
- **`develop`** — integration branch. Feature and fix branches merge
  here; once green it's PR'd into `main` as a release.
- **`feature/{issue}-{short-description}`** — new features, one per issue.
- **`fix/{issue}-{short-description}`** — bug fixes, one per issue.
- **`docs/{issue}-{short-description}`** — documentation-only changes.
- **`release/x.y.z`** — release preparation (version bumps, changelog).

Never mix unrelated fixes in one branch. One issue → one branch → one PR.

---

## Working through an issue

When given an issue number or asked to work on an issue:

### 1. Read the issue fully

```bash
gh issue view {number}
```

Read the full description, acceptance criteria, and linked issues. Do not
start coding until you understand the expected behaviour and have a
theory of the fix.

### 2. Understand the codebase context

- Read every file the issue references.
- Reproduce the bug locally to confirm it exists (for bug fixes).
- Trace the code path from trigger to symptom before proposing a fix.

If you can't reproduce the bug, stop and ask — fixing what you can't
reproduce is how regressions are born.

### 3. Create a branch off `develop`

```bash
git checkout develop
git pull origin develop
git checkout -b fix/{issue-number}-{short-description}
```

Use `feature/`, `fix/`, or `docs/` prefix to match the kind of work.

### 4. Implement the smallest change that fixes the issue

- Make the change. Only the change. Don't refactor adjacent code "while
  you're in there".
- Don't add features not in the issue. If you spot something else, raise
  a new issue for it (see below).
- Don't add speculative error handling, backwards-compat shims, or
  unrelated tidy-ups.

### 5. Verify

Every PR must satisfy at minimum:

```bash
# Client build passes
cd client && bun run build    # expect zero errors

# Server starts and /api/health responds
cd server && timeout 8 bun index.js &
sleep 5 && curl -sf localhost:4000/api/v1/health && echo "ok"
```

Plus every acceptance-criteria checkbox in the issue. Don't mark a PR
ready for review with any of them unchecked.

### 6. Commit with issue reference

```bash
git add -A
git commit -m "fix: {issue title} (#{issue})

{brief explanation of what changed and why}

Closes #{issue}"
```

Use conventional commit prefixes: `fix:`, `feat:`, `docs:`, `chore:`,
`refactor:`, `test:`. The `Closes #{issue}` footer auto-closes the
issue when the PR merges.

### 7. Push and open a PR

```bash
git push -u origin {branch}
```

```bash
gh pr create \
  --base develop \
  --title "fix: {issue title}" \
  --body "## Summary
{What this PR does, 1–3 bullets.}

## Changes
- {file}: {what changed}
- {file}: {what changed}

## Testing
- [ ] Acceptance criteria from issue verified
- [ ] \`cd client && bun run build\` passes
- [ ] Server starts and /api/v1/health returns ok

Closes #{issue}"
```

PRs always target `develop`, never `main` directly (except release PRs).

### 8. After merge

Issues auto-close via the `Closes #{issue}` footer. If the footer wasn't
set, close manually:

```bash
gh issue close {number} --comment "Fixed in #{pr}."
```

---

## Working through multiple issues

When given a batch of issues:

1. **Prioritise**: bugs before enhancements; `v1.0` label first; security
   issues highest priority of all.
2. **One branch per issue** — never mix fixes in a single branch.
3. **Sequential, not parallel** — finish + merge one before starting the
   next, so `develop` stays green.
4. **Rebase on develop** before pushing if others have merged since you
   branched (solo-dev this is rare, but honour it).

---

## Raising new issues

When you find a bug or missing piece while working on something else,
**don't fold it into the current PR**. Raise a new issue:

```bash
bash scripts/raise-issue.sh "bug: {specific title}" "description" bug
```

Or directly:

```bash
gh issue create \
  --title "bug: {specific description}" \
  --label "bug" \
  --body "## Found while working on #{related-issue}

## Problem
{what is broken}

## Expected behaviour
{what should happen}

## Reproduction
{how to reproduce}

## Acceptance criteria
- [ ] {specific testable criterion}"
```

Stay frugal — don't raise issues for things you've already fixed, and
don't raise vague "it'd be nice if…" issues. Every issue should have
at least one concrete acceptance criterion.

---

## Preparing a release

When told "prepare v{x.y.z} release":

1. **Collect what's in it.**
   ```bash
   gh pr list --state merged --base develop --limit 100
   gh issue list --state closed --limit 100
   ```

2. **Write the CHANGELOG entry** in Keep a Changelog format. Group under
   Added / Changed / Fixed / Removed / Security. Reference issue numbers.

3. **Bump versions**: `package.json` (root, server, client) and the
   `/api/v1/version` endpoint string.

4. **Open a release PR** `release/{x.y.z}` from `develop` into `main`:
   ```bash
   git checkout develop && git pull
   git checkout -b release/{x.y.z}
   # bump versions + update CHANGELOG
   git commit -m "chore(release): v{x.y.z}"
   git push -u origin release/{x.y.z}
   gh pr create --base main --title "release: v{x.y.z}" --body "..."
   ```

5. **Once merged**, tag and release:
   ```bash
   git checkout main && git pull
   git tag -a v{x.y.z} -m "Blueprint v{x.y.z}"
   git push origin v{x.y.z}
   gh release create v{x.y.z} \
     --title "Blueprint v{x.y.z}" \
     --notes "$(sed -n '/## \[{x.y.z}\]/,/## \[/p' CHANGELOG.md | head -n -1)" \
     --target main
   ```

   Pre-releases (alpha/beta/rc): add `--prerelease`.

6. **Fast-forward develop**:
   ```bash
   git checkout develop && git merge main --ff-only && git push
   ```

---

## What not to do

- ❌ Commit directly to `main` or `develop`.
- ❌ Force-push to `main` or any shared branch.
- ❌ Bypass pre-commit hooks with `--no-verify`.
- ❌ Amend published commits.
- ❌ Mix unrelated fixes in one branch or one PR.
- ❌ Mark a PR ready when acceptance criteria aren't ticked.
- ❌ Close an issue without the PR number in the comment.

---

## Quick reference

```bash
# Pick up an issue
gh issue view 42
git checkout develop && git pull && git checkout -b fix/42-skipped-runs-count

# Work, verify, commit
cd client && bun run build
git add -A && git commit -m "fix: skipped runs counted in activity (#42)

Closes #42"

# Push + PR
git push -u origin fix/42-skipped-runs-count
gh pr create --base develop --title "fix: skipped runs counted in activity"

# Raise while working
bash scripts/raise-issue.sh "bug: title" "description" bug
```
