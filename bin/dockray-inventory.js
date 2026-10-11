#!/usr/bin/env node
import { InventoryReporter } from '../src/inventory.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--force' && arg !== '--help')) {
    console.error('Usage: dockray-inventory [--force]');
    process.exitCode = 1;
} else if (args.includes('--help')) {
    console.log('Usage: dockray-inventory [--force]. Configure RAY_INVENTORY=true and RAY_INVENTORY_SITE_URL alongside existing project credentials.');
} else {
    const reporter = new InventoryReporter({
        enabled: process.env.RAY_INVENTORY === 'true',
        token: process.env.RAY_TOKEN, privateKey: process.env.RAY_PRIVATE_KEY,
        siteUrl: process.env.RAY_INVENTORY_SITE_URL,
        projectDirectory: process.env.RAY_INVENTORY_PROJECT_DIR,
        stateDirectory: process.env.RAY_INVENTORY_STATE_DIR,
        excludePackages: (process.env.RAY_INVENTORY_EXCLUDE_PACKAGES ?? '').split(',').map((name) => name.trim()).filter(Boolean),
    });
    const result = await reporter.report({ force: args.includes('--force') });
    console.log(`DockRay inventory: ${result.status}${result.components !== undefined ? `; packages: ${result.components}; vulnerable: ${result.vulnerable}` : ''}`);
    process.exitCode = ['sent', 'disabled', 'not_due', 'backoff', 'busy'].includes(result.status) ? 0 : 1;
}
