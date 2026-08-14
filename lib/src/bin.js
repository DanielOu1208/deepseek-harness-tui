#!/usr/bin/env node
import { productionDependencies, runLauncher } from './launcher.js';
try {
    process.exitCode = await runLauncher(process.argv.slice(2), productionDependencies());
}
catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}
