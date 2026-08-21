# Contributing

## Development

```sh
pnpm install
pnpm test
pnpm build
```

```sh
pnpm version patch  # or minor/major
```

That runs lint, format, types, tests and build, regenerates CHANGELOG.md with
git-cliff, then pushes the tag, which triggers the publish workflow.

## Docs

Two of the diagrams are drawn from the source rather than by hand, so that a
change nobody redraws is a failing test rather than a picture that has quietly
stopped being true:

```sh
pnpm diagrams
```

`docs/img/architecture.dot` is the call graph — every node a function in `src/`,
every edge a call the source makes, every number read from `constants.ts`.
`docs/img/chunks.svg` is drawn by _running_ the chunk cache against a recording
`fetch`: the chunk states and the range headers in it are what that read
actually did. `test/diagrams.test.ts` regenerates both and compares, and a step
that has been renamed out of `NODES` fails with the name it can no longer find.

`docs/img/dataflow.svg` is the exception, hand-drawn from `dataflow.dot` and
committed since GitHub does not render DOT:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
```

Both `.svg` renders of a `.dot` are committed and unchecked, because graphviz is
not a dependency and different versions emit different SVG bytes — a staleness
check on them would fail on toolchain drift rather than on a stale diagram.
`pnpm diagrams` re-renders `architecture.svg` where graphviz exists and says so
where it does not.

## Publishing

Releases publish automatically via GitHub Actions using npm trusted publishing
(OIDC, no stored token). The workflow requires `--provenance` and
`id-token: write` permissions.

This repo is already configured. To set up a new package:
`npm trust github <pkg> --file publish.yml --repo GMOD/<repo>` (requires
npm >=11.10.0 and 2FA).

Once npm publish succeeds, the `release` job creates the GitHub release for the
tag, taking its notes from that version's CHANGELOG.md section — which
`scripts/release-notes.sh` extracts, so run that with a version to preview what
a release will say.
