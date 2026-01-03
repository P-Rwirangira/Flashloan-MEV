#!/usr/bin/env node

/* eslint-disable no-console */
/**
 * Development Entry Point with Interactive Menu
 *
 * This is the entry point for `npm run dev` that shows an interactive menu
 * allowing users to select which strategies to run.
 */

import { InteractiveMenu } from './interactive-menu';

async function main() {
  const menu = new InteractiveMenu();

  try {
    await menu.start();
  } catch (error) {
    console.error('Error in interactive menu:', error);
    await menu.cleanup();
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

main().catch(console.error);
