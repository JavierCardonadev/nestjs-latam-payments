# Contributing

Thanks for helping! Issues and PRs are welcome in English or Spanish.

## Setup

```bash
git clone https://github.com/JavierCardonadev/nestjs-latam-payments.git
cd nestjs-latam-payments
npm install
npm test
```

Node.js ≥ 20.19 is required.

## Before opening a PR

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

- Keep the package free of runtime dependencies.
- Every change to signatures, status mapping or money handling needs tests. Prefer official test vectors from the provider's documentation and link the source.
- Never commit real credentials. Only public sandbox credentials published by the provider are allowed in tests.
- Update `CHANGELOG.md` under **Unreleased**.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(kushki): …`, `fix(payu): …`).

## New providers

Read [docs/adding-a-provider.md](docs/adding-a-provider.md). Roadmap providers are tracked with the `provider` label.

## Releases

Maintainers tag `vX.Y.Z`; the release workflow publishes to npm with provenance.
