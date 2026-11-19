# Contributing

Thanks for your interest in improving `workers-logs-reader`. The bar for a
change is whether it keeps the one promise the package makes: a read it reports
as complete holds every event in the window, and a read it cannot vouch for says
so. Bug fixes, a response shape the API has started returning, sharper messages,
and clearer docs are all welcome.

Use [Bun](https://bun.sh) 1.4.4. Keep changes on a branch and open a pull
request that says what behavior changes and how you verified it.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

eslint runs in CI through ci-baseline. To run the same check locally, after
installing dependencies: `<a ci-baseline checkout>/lib/lint-local.sh`. It runs
the ci-baseline commit this repository's workflows pin.

The tests need no Cloudflare account: every request goes through an injected
`fetch`, and the fixtures in `src/test-fixtures.ts` are invented. A report of a
response the package misreads is most useful with the response's shape and any
event bodies replaced by invented ones.

## Maintainership and review

Curlew Labs maintains this project. Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) reviews changes
and approves the releases that [need approval](#releases). Use issues for
reproducible defects and proposals; use
[private vulnerability reporting](SECURITY.md) for security concerns.

Changes land through pull requests with passing CI and maintainer review. Every
dependency is pinned to an exact version. A test that guards a failure mode says
which one, and comments explain why, not what.

## Releases

A patch or minor release needs no approval: whoever cuts it follows the steps
below in order, on a `main` commit whose required checks have passed. A major
version, a 1.0, or a minor before 1.0 that changes an interface consumers use
needs the maintainer's explicit approval before its tag is pushed.

1. Set `version` in `package.json` on `main`.
2. Push the tag `vX.Y.Z` at that commit. The Release workflow runs CI, packs the
   tarball and opens a draft release with it attached.
3. Check the draft, then publish it. Releases are immutable: a published
   release's tag and assets cannot be changed, so a fix is a new version.

## License

By submitting a contribution for inclusion in this project, you agree that it is
licensed under the MIT and Apache-2.0 licenses, as the README's License section
describes, without any additional terms or conditions.
