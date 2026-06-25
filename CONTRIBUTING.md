# Contributing to kin-editor

Thanks for your interest in kin-editor. This guide covers local development, the
conventions this repository follows, and how to get changes reviewed.

## Development Setup

kin-editor is a TypeScript VS Code extension. You need Node.js (v18+) and npm:

```sh
npm install
npm run compile
```

Before opening a pull request, make sure the standard checks pass:

```sh
npm run lint
npm test
npm run compile
```

To package a local build:

```sh
npm run package:vsix
```

## DCO Sign-Off

This project uses the [Developer Certificate of Origin
(DCO)](https://developercertificate.org/). Every commit you push on a pull
request must carry a `Signed-off-by` trailer:

```
Signed-off-by: Your Name <you@example.com>
```

Add it by passing `-s` to `git commit`:

```sh
git commit -s -m "feat(explorer): add entity kind filter"
```

If you forgot to sign off earlier commits on your branch:

```sh
git commit -s --amend              # amend only the last commit
git rebase --signoff HEAD~N        # add sign-off to the last N commits
```

By signing off you certify that you wrote the code (or have the right to
submit it) and that it may be distributed under the Apache License 2.0 that
governs this repository. Bot-authored commits (Dependabot, GitHub Actions)
are exempt.

## AI-Assisted Contributions

Kin is built with significant AI assistance, and we welcome AI-assisted
contributions from the community. A few requirements:

- **You are responsible for AI-generated code you submit.** Review every
  line before opening a PR. If the model hallucinated an API call, an
  unsound block, or a security hole, that is your bug to catch.
- **AI-generated code is your contribution.** By signing off your commits
  you assert that you have reviewed the generated code and are submitting it
  under your own name, not as a third-party work. Firelock asserts copyright
  over AI-generated code it produces; you assert copyright over what you
  produce and submit here.
- **No raw model output in commit messages or comments.** Clean up generated
  prose before it lands in public history. Write durable, human-authored
  commit messages that describe the technical change.

## Commit Messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org/).
Recent history shows the expected shape — a `type(scope): summary` subject:

```
feat(explorer): add entity kind filter to sidebar tree
fix(search): handle empty graph response gracefully
docs(readme): add marketplace install instructions
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, and
`chore`. Scopes match the area you touched (`explorer`, `search`, `trace`,
`status`, `commands`, and so on). Write the summary in the imperative mood
and keep it focused on what changed and why.

## Branch Naming and Commit Hygiene

Public Git history is part of the product, so keep it clean and reviewable:

- **Keep branch names topical, not tracker-coded.** Prefer short, descriptive
  names like `fix/search-empty-state` or `feat/entity-kind-filter`. Avoid
  embedding internal issue or tracker IDs in a branch name — a squash merge
  copies the branch name into the public commit subject, so anything in the
  branch name lands in history verbatim.
- **Write durable subjects and bodies.** Commit messages should describe the
  technical change and why it was made. Keep internal tracker IDs, session
  identifiers, and automated authorship trailers out of public commit
  metadata; link that context from the pull request instead.
- **Don't bypass the hooks.** Repository hooks normalize commit metadata for
  consistency — don't skip them with `--no-verify`.

## Pull Requests

- **Keep PRs scoped.** Stage only the files your change actually needs.
  Unrelated cleanups belong in their own PR — this keeps review focused and
  history bisectable.
- Make sure `npm run lint`, `npm test`, and `npm run compile` all pass.
- If your change is user-facing, briefly describe it in the PR body so
  reviewers understand the before/after behavior.

## Reporting Issues

File issues on [firelock-ai/kin-editor](https://github.com/firelock-ai/kin-editor/issues)
using the provided templates:

- **Bug reports** — use the bug report template.
- **Feature requests** — use the feature request template.

For security vulnerabilities, do **not** open a public issue. Follow the
private reporting process in [SECURITY.md](SECURITY.md).

## Repository Boundaries

kin-editor is one repository within a larger ecosystem. Semantic graph storage
and retrieval internals live in `kin-db`; the system of record CLI and daemon
live in `kin`. If your change targets one of those concerns, open it against
the repository that owns the code.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the license that covers this repository.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you are expected to uphold it.
