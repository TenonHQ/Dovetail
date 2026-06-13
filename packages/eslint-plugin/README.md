# @tenonhq/dovetail-eslint-plugin

## Overview

This plugin allows you to run the [ESLint](https://eslint.org/) checker on files.

## Installation

```bash
npm i -D @tenonhq/dovetail-eslint-plugin
```

### Order of Configurations

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
