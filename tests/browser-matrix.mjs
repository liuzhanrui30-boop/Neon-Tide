import assert from 'node:assert/strict';
import {
  APP_URL,
  BROWSER_MATRIX_SCENARIO,
  CDP_HTTP,
  REALM_SCREENSHOT_ONLY,
  breakpointCleanupFailurePathSelfTest,
  captureNaturalRealmScreenshots,
} from './browser/harness.mjs';
import { v22RegressionScenarios } from './browser/v22-regressions.mjs';
import { v3FoundationScenarios } from './browser/v3-foundation.mjs';

const browserScenarios = [...v3FoundationScenarios, ...v22RegressionScenarios];
const selectedScenarios = BROWSER_MATRIX_SCENARIO
  ? browserScenarios.filter(([name]) => name.includes(BROWSER_MATRIX_SCENARIO))
  : browserScenarios;
let passed = 0;

try {
  if (process.env.BROWSER_MATRIX_BREAKPOINT_CLEANUP_SELF_TEST === '1') {
    await breakpointCleanupFailurePathSelfTest();
    console.log('ok 1 - paused-timeout breakpoint cleanup');
    console.log('1..1');
  } else {
    const versionResponse = await fetch(`${CDP_HTTP}/json/version`);
    assert.ok(versionResponse.ok, `Chrome CDP is not available at ${CDP_HTTP}`);
    const version = await versionResponse.json();
    console.log(`# ${version.Browser}; app=${APP_URL}`);

    if (REALM_SCREENSHOT_ONLY) {
      await captureNaturalRealmScreenshots();
      console.log('ok 1 - natural 12/44/78/108 second release screenshots');
      console.log('1..1');
    } else {
      assert.ok(selectedScenarios.length > 0, `No browser scenario matched ${BROWSER_MATRIX_SCENARIO}`);
      for (const [name, scenario] of selectedScenarios) {
        const started = Date.now();
        await scenario();
        passed += 1;
        console.log(`ok ${passed} - ${name} (${Date.now() - started}ms)`);
      }
      console.log(`1..${selectedScenarios.length}`);
    }
  }
} catch (error) {
  const selfTest = process.env.BROWSER_MATRIX_BREAKPOINT_CLEANUP_SELF_TEST === '1';
  const expected = selfTest || REALM_SCREENSHOT_ONLY ? 1 : selectedScenarios.length;
  const failedName = selfTest
    ? 'paused-timeout breakpoint cleanup'
    : REALM_SCREENSHOT_ONLY
      ? 'natural 12/44/78/108 second release screenshots'
      : selectedScenarios[passed]?.[0] || 'browser matrix setup';
  console.error(`not ok ${selfTest || REALM_SCREENSHOT_ONLY ? 1 : passed + 1} - ${failedName}`);
  console.error(error?.stack || error);
  console.log(`1..${expected}`);
  process.exitCode = 1;
}
