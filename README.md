# adaptive-concurrency-toolkit

TypeScript adaptive concurrency primitives inspired by Netflix's
[`concurrency-limits`](https://github.com/Netflix/concurrency-limits).

A pnpm + turborepo monorepo. The first package is `core`, which implements
the algorithms (`AimdLimit`, `VegasLimit`, `Gradient2Limit`, `FixedLimit`)
and a minimal `SimpleLimiter`. Higher-level wrappers (HTTP, RPC, queues)
will live in sibling packages.

## Packages

| Package                                                  | Purpose                              |
| -------------------------------------------------------- | ------------------------------------ |
| [`@adaptive-concurrency-toolkit/core`](./packages/core/) | Limit algorithms and base `Limiter`. |

## Tooling

- **pnpm** workspaces with `catalog:` for unified versioning
- **turborepo** for build orchestration
- **TypeScript** with [`@lokalise/tsconfig`](https://www.npmjs.com/package/@lokalise/tsconfig); pure ESM output
- **vitest** for tests
- **oxlint** + **oxfmt** for lint and format

## Scripts

```sh
pnpm install
pnpm build          # tsc per package via turbo
pnpm test           # vitest run per package
pnpm typecheck
pnpm lint           # oxfmt --check && oxlint
pnpm lint:fix       # oxfmt && oxlint --fix
```

Requires Node ≥ 22.12 for development (native TypeScript type stripping).
Published packages run on Node ≥ 20.
