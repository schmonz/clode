# Repo git hooks

Enable them once per clone:

    git config core.hooksPath .githooks

`post-merge` / `post-checkout` keep the local toolchain in step with
`.tool-versions`. When a pull or branch switch changes that file, any newly
pinned version is installed with `asdf`; otherwise they do nothing.

They exist because Renovate bumps `nodejs` in `.tool-versions` regularly, and
until someone ran `asdf install` by hand, `node` stopped resolving in the
checkout — which surfaces as "No version is set for command node" in the middle
of unrelated work. That happened twice on 2026-08-27 alone.

Both hooks are deliberately unable to fail a git operation: they exit 0 even if
`asdf` is missing or an install fails, printing what to run by hand. A hook that
can block a `git pull` is worse than the problem it solves.
