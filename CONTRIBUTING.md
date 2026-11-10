# Contributing

Bug reports, focused fixes and measured optimization improvements are welcome.
For installation bugs, include Windows version, PoB version, addon version and
the exact error. Remove build/account details you do not want to publish.

1. Fork the repository and create a branch.
2. Use Node.js 22 or newer and run `npm ci`.
3. Run `npm test` and `npm run check`.
4. Describe the resulting behavior and relevant validation in your pull request.

Use an isolated PoB installation and disposable builds for native integration
tests. Do not include credentials, user builds, generated `.pob-helper` files,
runtime caches or release binaries in commits.

Build changes must remain bound to measured XML, the active build and the
installed calculator version. Keep stale-change rejection, rollback and commit
receipts intact. Research/build evidence must satisfy the current and previous
league policy. Do not add legacy build templates or bypass validation.

Contributions are licensed under the repository's MIT license. Preserve all
third-party notices and use original or appropriately licensed visual assets.
