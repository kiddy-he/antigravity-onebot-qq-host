import {fail} from '../errors.js';
export async function loadChromium() {
  try { return (await import('playwright-core')).chromium; } catch { fail('browser_dependency_missing'); }
}
