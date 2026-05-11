# @tenonhq/dovetail-types

Shared TypeScript type definitions for the Dovetail monorepo.

## Install

```bash
npm i -D @tenonhq/dovetail-types
```

## Contents

A single ambient declaration file (`index.d.ts`) exposing two namespaces:

- **`Sinc`** — Dovetail internal types: config shape (`Config`, `ScopedConfig`), CLI args (`PushCmdArgs`, `WatchCmdArgs`, etc.), manifests, plugin rules, field maps, and build-pipeline transforms.
- **`SN`** — ServiceNow platform types: `FileType`, record shapes, REST response payloads used when talking to ServiceNow.

## Usage

```typescript
import type { Sinc, SN } from "@tenonhq/dovetail-types";

function loadConfig(raw: unknown): Sinc.Config { /* ... */ }

function handlePush(args: Sinc.PushCmdArgs) { /* ... */ }
```

Because these are ambient types, consumers typically install as a `devDependency` and reference them via `import type`. Runtime code is not emitted by this package.

## Related

Consumed by `@tenonhq/dovetail-core` and every build plugin package in this monorepo (`babel-plugin`, `typescript-plugin`, `webpack-plugin`, `sass-plugin`, `eslint-plugin`, `prettier-plugin`).
