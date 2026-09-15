#!/usr/bin/env node
'use strict';
// Bootstrap uses only Node built-ins and works when all lifecycle scripts are disabled.
import('../scripts/deployment/cli.mjs').then(({ main }) => main()).catch(error => {
  console.error(`Revcode: ${error.message}`);
  process.exitCode = 1;
});
