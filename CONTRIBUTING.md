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

`pnpm version patch` runs lint, format, types, tests and build, regenerates
CHANGELOG.md with git-cliff, then pushes the tag, which triggers the publish
workflow.

## Docs

[docs/api.md](docs/api.md) is written by hand, and `test/apiDocs.test.ts` fails
when a public member of `RemoteFileWithRangeCache`, `CachedFilehandle`, or an
export, is missing from it. Document the new member, or add it to the test's
`undocumented` list with the reason it is internal.

`pnpm diagrams` draws two of the diagrams from the source, so a code change that
leaves either diagram out of date fails a test:

```sh
pnpm diagrams
```

`docs/img/architecture.dot` is the call graph. Each node is a function in
`src/`, each edge is a call the source makes, and each number comes from
`constants.ts`. `docs/img/chunks.svg` is drawn by _running_ the chunk cache
against a recording `fetch`, so its chunk states and range headers show what
that read did. `test/diagrams.test.ts` regenerates both and compares, and a step
that has been renamed out of `NODES` fails with the name it can no longer find.

`docs/img/dataflow.svg` is the exception, hand-drawn from `dataflow.dot` and
committed since GitHub does not render DOT:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
```

`architecture.svg` and `dataflow.svg` are committed and unchecked, because
graphviz is not a dependency and different versions emit different SVG bytes. A
check on them would fail whenever the graphviz version changed, whether or not
the diagram was out of date. `pnpm diagrams` re-renders `architecture.svg` where
graphviz is installed, and prints a message where it is not.

## Publishing

Releases publish automatically via GitHub Actions using npm trusted publishing
(OIDC, no stored token). The workflow requires `--provenance` and
`id-token: write` permissions.

Trusted publishing is already configured for this repo. To set up a new package:
`npm trust github <pkg> --file publish.yml --repo GMOD/<repo>` (requires
npm >=11.10.0 and 2FA).

Once npm publish succeeds, the `release` job creates the GitHub release for the
tag. `scripts/release-notes.sh` extracts the notes from that version's
CHANGELOG.md section; run it with a version to preview a release's notes.
