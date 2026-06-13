# @tenonhq/dovetail-eslint-plugin

## Overview

Runs [ESLint](https://eslint.org/) on files as part of the Dovetail build pipeline.

## Requirements

- Node.js >= 22
- ESLint 8.x (the plugin ships `eslint@8.51.0` as a dependency)

## Installation

```bash
npm i -D @tenonhq/dovetail-eslint-plugin
```

### Configuration Order

1. Load from `dove.config.js` options.
2. Check for `.eslintrc` file or generate one.

## Example Usage

This example takes `.ts` files and runs eslint on them. The output with errors and warnings
is printed on the console. If there are any errors the code is not pushed.

```javascript
// dove.config.js
module.exports = {
  rules: {
    match: /\.ts$/,
    plugins: [
      { name: "@tenonhq/dovetail-eslint-plugin" },
    ],
  },
};
```
