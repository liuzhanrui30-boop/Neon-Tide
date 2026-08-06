import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173/';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const WALL_STALL_MS = Number(process.env.WALL_STALL_MS || 1200);
const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;
const REALM_SCREENSHOT_DIR = process.env.REALM_SCREENSHOT_DIR || '';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class CDPClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.waiters = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP WebSocket connection timed out')), 6000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('CDP WebSocket connection failed'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.#onMessage(JSON.parse(String(event.data))));
  }

  #onMessage(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }

    for (const listener of this.listeners.get(message.method) || []) listener(message.params);
    const waiters = this.waiters.get(message.method) || [];
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message.params)) continue;
      this.waiters.set(message.method, waiters.filter((candidate) => candidate !== waiter));
      clearTimeout(waiter.timeout);
      waiter.resolve(message.params);
      break;
    }
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, predicate = () => true, timeoutMs = 30000) {
    let cancel;
    const promise = new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timeout = setTimeout(() => {
        const waiters = this.waiters.get(method) || [];
        this.waiters.set(method, waiters.filter((candidate) => candidate !== waiter));
        reject(new Error(`${method} event timed out`));
      }, timeoutMs);
      const waiters = this.waiters.get(method) || [];
      waiters.push(waiter);
      this.waiters.set(method, waiters);
      cancel = () => {
        const currentWaiters = this.waiters.get(method) || [];
        this.waiters.set(method, currentWaiters.filter((candidate) => candidate !== waiter));
        clearTimeout(waiter.timeout);
        resolve(undefined);
      };
    });
    promise.cancel = () => cancel?.();
    return promise;
  }

  close() {
    this.socket?.close();
  }
}

async function createTarget() {
  const response = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`Cannot create Chrome target: HTTP ${response.status}`);
  return response.json();
}

async function closeTarget(targetId) {
  try {
    await fetch(`${CDP_HTTP}/json/close/${targetId}`, { signal: AbortSignal.timeout(3000) });
  } catch {
    // Chrome may already have closed the target after a fatal page failure.
  }
}

function offsetToLocation(source, offset) {
  const before = source.slice(0, offset);
  const lineNumber = before.split('\n').length - 1;
  const previousNewline = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return { lineNumber, columnNumber: offset - (previousNewline + 1) };
}

function keyDefinition(key, code) {
  if (key === 'Tab') return { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
  if (key === ' ') return { windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  if (/^[0-9]$/.test(key)) {
    const value = key.charCodeAt(0);
    return { windowsVirtualKeyCode: value, nativeVirtualKeyCode: value };
  }
  const value = key.toUpperCase().charCodeAt(0);
  return { windowsVirtualKeyCode: value, nativeVirtualKeyCode: value, code };
}

class GamePage {
  constructor(name, target, client, options) {
    this.name = name;
    this.target = target;
    this.client = client;
    this.options = options;
    this.scripts = new Map();
    this.failures = [];
    this.consoleErrors = [];
    this.scopeEvaluationCount = 0;
  }

  static async open(name, options = {}) {
    const target = await createTarget();
    const client = new CDPClient(target.webSocketDebuggerUrl);
    await client.connect();
    const page = new GamePage(name, target, client, {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
      reducedMotion: false,
      ...options,
    });
    await page.#initialize();
    return page;
  }

  async #initialize() {
    this.client.on('Debugger.scriptParsed', (params) => {
      if (params.url) this.scripts.set(params.url, params);
    });
    this.client.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails;
      this.failures.push(`exception: ${details.exception?.description || details.text || 'unknown'}`);
    });
    this.client.on('Runtime.consoleAPICalled', (params) => {
      if (!['error', 'assert'].includes(params.type)) return;
      const text = params.args.map((argument) => argument.value ?? argument.description ?? '').join(' ');
      this.consoleErrors.push(`${params.type}: ${text}`);
    });
    this.client.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') this.failures.push(`log: ${entry.text}`);
    });
    this.client.on('Network.loadingFailed', (params) => {
      if (!params.canceled) this.failures.push(`network: ${params.errorText} (${params.type})`);
    });
    this.client.on('Network.responseReceived', ({ response }) => {
      if (response.status >= 400) this.failures.push(`http ${response.status}: ${response.url}`);
    });

    await Promise.all([
      this.client.send('Page.enable'),
      this.client.send('Runtime.enable'),
      this.client.send('Debugger.enable'),
      this.client.send('Log.enable'),
      this.client.send('Network.enable'),
    ]);
    await this.client.send('Page.bringToFront');
    await this.client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.client.send('Emulation.setDeviceMetricsOverride', {
      width: this.options.width,
      height: this.options.height,
      screenWidth: this.options.width,
      screenHeight: this.options.height,
      deviceScaleFactor: this.options.deviceScaleFactor,
      mobile: this.options.mobile,
    });
    await this.client.send('Emulation.setTouchEmulationEnabled', {
      enabled: this.options.touch,
      maxTouchPoints: this.options.touch ? 5 : 1,
    });
    await this.client.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{
        name: 'prefers-reduced-motion',
        value: this.options.reducedMotion ? 'reduce' : 'no-preference',
      }],
    });

    const loaded = this.client.waitFor('Page.loadEventFired');
    await this.client.send('Page.navigate', { url: APP_URL });
    await loaded;
    await this.waitForPage(`document.readyState === 'complete' && Boolean(document.querySelector('canvas'))`);
    await this.waitForPage(`document.activeElement?.id === 'primary-button'`);
    await this.#discoverGameScript();
  }

  async #discoverGameScript() {
    let scriptInfo = null;
    let kind = null;
    for (const [url, info] of this.scripts) {
      if (/\/src\/main\.js(?:\?|$)/.test(url)) {
        scriptInfo = info;
        kind = 'dev';
      } else if (/\/assets\/index-[^/]+\.js(?:\?|$)/.test(url)) {
        scriptInfo = info;
        kind = 'production';
      }
    }
    assert.ok(scriptInfo, `${this.name}: game script was not parsed`);
    const { scriptSource: source } = await this.client.send('Debugger.getScriptSource', { scriptId: scriptInfo.scriptId });
    this.scriptInfo = scriptInfo;
    this.source = source;
    this.scriptKind = kind;

    if (kind === 'dev') {
      const marker = source.indexOf('function animate()');
      assert.ok(marker >= 0, `${this.name}: animate() marker missing`);
      const functionLine = offsetToLocation(source, marker).lineNumber;
      // Break on the function declaration itself; V8 maps the first executable
      // statement to this source line in both dev and production transforms.
      this.breakpointLocation = { scriptId: scriptInfo.scriptId, lineNumber: functionLine, columnNumber: 0 };
      this.names = {
        state: 'state',
        enemies: 'enemies',
        audio: 'audio',
        player: 'player',
        renderer: 'renderer',
      };
      return;
    }

    const marker = source.lastIndexOf('.getDelta()');
    assert.ok(marker >= 0, `${this.name}: production animate marker missing`);
    this.breakpointLocation = { scriptId: scriptInfo.scriptId, ...offsetToLocation(source, marker) };
    const animateWindow = source.slice(Math.max(0, marker - 3000), marker + 1200);
    const stateMatch = animateWindow.match(/function\s+[A-Za-z_$][\w$]*\(\)\{const\s+[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.getDelta\(\),[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\.reducedMotion/);
    const enemyMatches = [...source.matchAll(/([A-Za-z_$][\w$]*)\.find\(([A-Za-z_$][\w$]*)=>\2\.type==="boss"/g)];
    assert.ok(stateMatch && enemyMatches.length, `${this.name}: production state/enemy symbols missing`);
    this.names = {
      state: stateMatch[1],
      enemies: enemyMatches.at(-1)[1],
    };
  }

  requireDev(feature) {
    assert.equal(this.scriptKind, 'dev', `${this.name}: ${feature} requires the Vite dev source (APP_URL=${APP_URL})`);
  }

  async evaluate(expression, { idempotent = true } = {}) {
    const params = { expression, returnByValue: true, awaitPromise: true };
    let result;
    try {
      result = await this.client.send('Runtime.evaluate', params);
    } catch (error) {
      if (!idempotent || !String(error?.message).includes('Runtime.evaluate timed out')) throw error;
      await this.client.send('Debugger.resume', {}, 3000).catch(() => {});
      await this.client.send('Page.bringToFront', {}, 3000).catch(() => {});
      result = await this.client.send('Runtime.evaluate', params);
    }
    if (result.exceptionDetails) {
      throw new Error(`${this.name}: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async waitForPage(expression, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
      try {
        lastValue = await this.evaluate(`Boolean(${expression})`);
        if (lastValue) return true;
      } catch {
        // The execution context can briefly disappear during Vite reloads.
      }
      await sleep(25);
    }
    throw new Error(`${this.name}: page condition timed out: ${expression} (last=${lastValue})`);
  }

  async scopeEvaluate(expression, { stallMs = 0 } = {}) {
    this.scopeEvaluationCount += 1;
    const evaluationNumber = this.scopeEvaluationCount;
    await this.client.send('Page.bringToFront');
    const pausedPromise = this.client.waitFor('Debugger.paused');
    pausedPromise.catch(() => {});
    let breakpointId;
    try {
      const breakpoint = await this.client.send('Debugger.setBreakpoint', {
        location: this.breakpointLocation,
      });
      ({ breakpointId } = breakpoint);
      const paused = await pausedPromise;
      const frame = paused.callFrames.find((candidate) => candidate.functionName === 'animate') || paused.callFrames[0];
      if (stallMs > 0) await sleep(stallMs);
      const result = await this.client.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`${this.name}: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    } catch (error) {
      pausedPromise.cancel();
      throw new Error(`${this.name}: scope evaluation ${evaluationNumber} failed: ${error.message}`, { cause: error });
    } finally {
      if (breakpointId) await this.client.send('Debugger.removeBreakpoint', { breakpointId }, 3000).catch(() => {});
      await this.client.send('Debugger.resume', {}, 3000).catch(() => {});
    }
  }

  async gameEvaluate(body, { stallMs = 0 } = {}) {
    const aliases = [
      `const $state=${this.names.state}`,
      `const $enemies=${this.names.enemies}`,
    ];
    if (this.names.audio) aliases.push(`const $audio=${this.names.audio}`);
    if (this.names.player) aliases.push(`const $player=${this.names.player}`);
    if (this.names.renderer) aliases.push(`const $renderer=${this.names.renderer}`);
    return this.scopeEvaluate(`(()=>{${aliases.join(';')};${body}})()`, { stallMs });
  }

  async click(selector) {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, { idempotent: false });
  }

  async dispatchKey(type, key, code, extra = {}) {
    await this.client.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      ...keyDefinition(key, code),
      ...extra,
    });
  }

  async pressKey(key, code, extra = {}) {
    await this.dispatchKey('rawKeyDown', key, code, extra);
    await this.dispatchKey('keyUp', key, code, { modifiers: extra.modifiers || 0 });
  }

  async captureScreenshot(filePath) {
    const { data } = await this.client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  async dispatchRepeatedKey(key, code, count) {
    await this.evaluate(`(()=>{
      for(let index=0;index<${count};index+=1){
        window.dispatchEvent(new KeyboardEvent('keydown',{
          key:${JSON.stringify(key)},
          code:${JSON.stringify(code)},
          repeat:true,
          bubbles:true,
          cancelable:true,
        }));
      }
      return true;
    })()`, { idempotent: false });
  }

  async startGame() {
    await this.click('#primary-button');
    await this.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    await this.waitForPage(`document.activeElement?.tagName === 'CANVAS'`, 1500);
    assert.equal(await this.evaluate(`document.activeElement?.tagName`), 'CANVAS', `${this.name}: gameplay focus did not move to the canvas`);
    assert.equal(await this.evaluate(`document.activeElement?.matches('button')`), false, `${this.name}: gameplay focus remains on a button`);
  }

  async assertClean() {
    await sleep(100);
    assert.deepEqual(this.consoleErrors, [], `${this.name}: console errors\n${this.consoleErrors.join('\n')}`);
    assert.deepEqual(this.failures, [], `${this.name}: runtime/network errors\n${this.failures.join('\n')}`);
  }

  async close() {
    await closeTarget(this.target.id);
    this.client.close();
  }
}

async function withPage(name, options, callback) {
  const page = await GamePage.open(name, options);
  try {
    await callback(page);
    await page.assertClean();
  } finally {
    await page.close();
  }
}

async function desktopCoreScenario() {
  await withPage('desktop-core', {}, async (page) => {
    const load = await page.evaluate(`(()=>{
      const root=document.documentElement;
      return {
        canvas:Boolean(document.querySelector('canvas')),
        focus:document.activeElement?.id,
        size:[innerWidth,innerHeight],
        overflow:[root.scrollWidth-innerWidth,root.scrollHeight-innerHeight],
        timer:document.querySelector('#time-value').textContent,
        label:document.querySelector('.time-card > span').textContent,
      };
    })()`);
    assert.equal(load.canvas, true);
    assert.equal(load.focus, 'primary-button');
    assert.deepEqual(load.size, [1440, 900]);
    assert.ok(load.overflow[0] <= 0 && load.overflow[1] <= 0, `desktop overflow: ${load.overflow}`);
    assert.equal(load.timer, '01:40');
    assert.equal(load.label, '首领接入');

    await page.startGame();
    page.requireDev('initial keyboard dash focus probe');
    await page.gameEvaluate(`
      clearWorldEntities();
      $state.enemySpawnTimer=999;
      $state.dashCharges=[1,1];
      $state.dashSequence=0;
      $state.dashTimer=0;
      input.dashBuffer=0;
      $player.velocity.set(0,0);
      return true;
    `);
    await page.pressKey(' ', 'Space');
    await sleep(80);
    const initialSpace = await page.gameEvaluate('return {mode:$state.mode,sequence:$state.dashSequence}');
    assert.deepEqual(initialSpace, { mode: 'playing', sequence: 1 }, 'Space after starting did not produce exactly one gameplay dash');

    const before = await page.gameEvaluate('return $state.elapsed');
    await page.gameEvaluate('return $state.elapsed', { stallMs: WALL_STALL_MS });
    await sleep(90);
    const after = await page.gameEvaluate('return $state.elapsed');
    const wallAdvance = after - before;
    assert.ok(wallAdvance >= WALL_STALL_MS / 1000 * 0.8, `wall clock only advanced ${wallAdvance.toFixed(3)}s`);

    page.requireDev('audio scheduler probe');
    await page.gameEvaluate(`
      if ($audio.context) {
        $audio._beatInitialized=true;
        $audio.nextBeatTime=$audio.context.currentTime-10;
      }
      return true;
    `);
    await page.click('#mute-button');
    assert.equal(await page.evaluate(`document.querySelector('#mute-button').getAttribute('aria-pressed')`), 'true');
    const muted = await page.gameEvaluate('return {muted:$audio.muted,initialized:$audio._beatInitialized,next:$audio.nextBeatTime}');
    assert.deepEqual(muted, { muted: true, initialized: false, next: 0 });
    await sleep(120);
    await page.click('#mute-button');
    await sleep(80);
    const unmuted = await page.gameEvaluate(`
      const now=$audio.context?.currentTime ?? 0;
      return {muted:$audio.muted,initialized:$audio._beatInitialized,next:$audio.nextBeatTime,now};
    `);
    assert.equal(unmuted.muted, false);
    assert.ok(unmuted.next === 0 || unmuted.next >= unmuted.now - 0.002, `stale beat ${unmuted.next} < ${unmuted.now}`);

    await page.dispatchKey('rawKeyDown', 'p', 'KeyP');
    await page.waitForPage(`document.querySelector('#overlay-kicker').textContent.includes('PAUSED')`);
    await page.dispatchRepeatedKey('p', 'KeyP', 3);
    assert.equal(await page.evaluate(`document.querySelector('#overlay').classList.contains('visible') && document.querySelector('#overlay-kicker').textContent.includes('PAUSED')`), true);
    await page.dispatchKey('keyUp', 'p', 'KeyP');

    await sleep(100);
    if (await page.evaluate(`document.activeElement?.id !== 'primary-button'`)) {
      await page.pressKey('Tab', 'Tab');
    }
    assert.equal(await page.evaluate('document.activeElement?.id'), 'primary-button');
    await page.pressKey('Tab', 'Tab');
    assert.equal(await page.evaluate('document.activeElement?.id'), 'primary-button');
    await page.pressKey('Tab', 'Tab', { modifiers: 8 });
    assert.equal(await page.evaluate('document.activeElement?.id'), 'primary-button');

    await page.click('#primary-button');
    await page.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    await sleep(80);
    assert.equal(await page.evaluate('document.activeElement?.tagName'), 'CANVAS');
    assert.equal(await page.evaluate(`document.activeElement?.matches('button')`), false);
    page.requireDev('dash repeat probe');
    await page.gameEvaluate(`
      clearWorldEntities();
      $state.enemySpawnTimer=999;
      $state.dashCharges=[1,1];
      $state.dashSequence=0;
      $state.dashTimer=0;
      input.dashBuffer=0;
      $player.velocity.set(0,0);
      return true;
    `);
    await page.dispatchKey('rawKeyDown', ' ', 'Space');
    await sleep(42);
    await page.dispatchRepeatedKey(' ', 'Space', 8);
    await page.dispatchKey('keyUp', ' ', 'Space');
    await sleep(80);
    const dash = await page.gameEvaluate('return {sequence:$state.dashSequence,charges:[...$state.dashCharges]}');
    assert.equal(dash.sequence, 1, `held Space triggered ${dash.sequence} dashes`);
    assert.ok(dash.charges[1] > 0.99, `second dash charge was consumed: ${dash.charges}`);

    // Let the live frame transition open the upgrade dialog. Calling
    // beginUpgrade while a debugger frame is paused can defer its focus
    // callback in headless Chrome and does not represent player input.
    await page.gameEvaluate(`
      $state.stageIndex=0;
      $state.stageQueue=[];
      $state.upgradeTriggered=[false,false];
      $state.elapsed=GAME.stageBoundaries[1];
      return true;
    `);
    await page.waitForPage(`!document.querySelector('#upgrade-panel').hidden`);
    await sleep(100);
    if (!await page.evaluate(`document.activeElement?.classList.contains('upgrade-option')`)) {
      await page.pressKey('Tab', 'Tab');
    }
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('.upgrade-option')).indexOf(document.activeElement)`), 0);
    await page.pressKey('Tab', 'Tab', { modifiers: 8 });
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('.upgrade-option')).indexOf(document.activeElement)`), 2);
    await page.pressKey('Tab', 'Tab');
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('.upgrade-option')).indexOf(document.activeElement)`), 0);

    const ownedBeforeRepeat = await page.gameEvaluate('return $state.ownedUpgrades.length');
    await page.dispatchRepeatedKey('1', 'Digit1', 1);
    assert.equal(await page.gameEvaluate('return $state.mode'), 'upgrade');
    assert.equal(await page.gameEvaluate('return $state.ownedUpgrades.length'), ownedBeforeRepeat);
    await page.pressKey('1', 'Digit1');
    await page.waitForPage(`document.querySelector('#upgrade-panel').hidden`);
    await page.waitForPage(`document.activeElement?.tagName === 'CANVAS'`);
  });
}

async function briefingAndLaserUiScenario() {
  await withPage('briefing-and-laser-ui', {}, async (page) => {
    const briefing = await page.evaluate(`({
      cards:document.querySelectorAll('#briefing-grid .mechanic-card').length,
      journey:document.querySelectorAll('#journey-strip li').length,
      copy:document.querySelector('#overlay-copy').textContent,
      energyLabel:document.querySelector('#mission-panel small').textContent,
      laserButton:Boolean(document.querySelector('#laser-button')),
      hullLabel:document.querySelector('.health-card > span').textContent,
    })`);
    assert.equal(briefing.cards, 4);
    assert.equal(briefing.journey, 4);
    assert.match(briefing.copy, /潮汐光矛/);
    assert.doesNotMatch(briefing.energyLabel, /护盾|OVERDRIVE/);
    assert.equal(briefing.laserButton, true);
    assert.equal(briefing.hullLabel, '船体');
  });

  await withPage('briefing-and-laser-phone', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
  }, async (page) => {
    const layout = await page.evaluate(`(()=>{
      const rect=(selector)=>{const element=document.querySelector(selector),r=element.getBoundingClientRect(),style=getComputedStyle(element);return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,display:style.display,visibility:style.visibility}};
      const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
      const briefing=rect('#briefing-grid'),joystick=rect('#joystick'),dash=rect('#dash-button'),laser=rect('#laser-button');
      return {briefing,joystick,dash,laser,overlaps:[overlap(briefing,joystick),overlap(briefing,dash),overlap(briefing,laser),overlap(joystick,dash),overlap(joystick,laser),overlap(dash,laser)]};
    })()`);
    for (const [name, rect] of Object.entries({ briefing: layout.briefing, joystick: layout.joystick, dash: layout.dash, laser: layout.laser })) {
      assert.notEqual(rect.display, 'none', `${name} is display:none`);
      assert.equal(rect.visibility, 'visible', `${name} is not visible`);
      assert.ok(rect.width > 0 && rect.height > 0, `${name} has zero size ${JSON.stringify(rect)}`);
      assert.ok(rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= 390.5 && rect.bottom <= 844.5,
        `${name} outside viewport ${JSON.stringify(rect)}`);
    }
    assert.deepEqual(layout.overlaps, [0, 0, 0, 0, 0, 0], `phone controls overlap ${JSON.stringify(layout)}`);
  });
}

async function chargedLightLanceScenario() {
  await withPage('charged-light-lance', {}, async (page) => {
    page.requireDev('pickup-charged light lance runtime probe');
    await page.startGame();
    const pickupContract = await page.gameEvaluate(`
      clearWorldEntities();
      $state.enemySpawnTimer=Infinity;
      $state.formationTimer=Infinity;
      $state.shardSpawnTimer=Infinity;
      $player.position.set(0,0);
      $player.velocity.set(0,0);
      $player.facing.set(1,0);
      syncPlayerTransform();
      const baseDerived=getDerivedValues();
      $state.ownedUpgrades=['overclock'];
      const focusedDerived=getDerivedValues();
      $state.ownedUpgrades=[];
      $state.weaponEnergy=40;
      awardReward('nearMiss');
      awardReward('break');
      awardReward('bossHit');
      const rewardEnergy=$state.weaponEnergy;
      $state.weaponEnergy=0;
      const collect=()=>{
        spawnShard($player.position.clone());
        collectShard(shards.length-1);
      };
      for(let index=0;index<19;index+=1) collect();
      const afterNineteen={energy:$state.weaponEnergy,state:$state.laserState,shots:$state.stats.laserShots};
      collect();
      const beforeFire={energy:$state.weaponEnergy,state:$state.laserState,shots:$state.stats.laserShots};
      return {
        afterNineteen,beforeFire,rewardEnergy,
        baseDerived,focusedDerived,hasOverdriveTimer:'overdriveTimer' in $state,
      };
    `);
    assert.deepEqual(pickupContract.baseDerived, {
      speedMultiplier:1,scoreMultiplier:1,pickupRadiusMultiplier:1,
      dashRecoveryMultiplier:1,dashInvulnerability:0.19,pickupWeaponEnergy:5,
    });
    assert.deepEqual(pickupContract.focusedDerived, {
      speedMultiplier:1,scoreMultiplier:1,pickupRadiusMultiplier:1,
      dashRecoveryMultiplier:1,dashInvulnerability:0.19,pickupWeaponEnergy:7,
    });
    assert.equal(pickupContract.rewardEnergy, 40);
    assert.equal(pickupContract.hasOverdriveTimer, false);
    assert.deepEqual(pickupContract.afterNineteen, { energy:95, state:'idle', shots:0 });
    assert.deepEqual(pickupContract.beforeFire, { energy:100, state:'ready', shots:0 });

    await page.pressKey('e', 'KeyE');
    await sleep(35);
    const charging = await page.gameEvaluate(`return {
      energy:$state.weaponEnergy,state:$state.laserState,shots:$state.stats.laserShots,
      buffer:input.laserBuffer,
    }`);
    assert.deepEqual(charging, { energy:0, state:'charge', shots:1, buffer:0 });

    const shot = await page.gameEvaluate(`
      $state.laserElapsed=LASER_RULES.chargeDuration;
      updateLaser(0);
      const active={
        visible:$player.laser.group.visible,
        length:$player.laser.group.scale.x,
        width:$player.laser.group.scale.y,
        haloColor:$player.laser.halo.material.color.getHex(),
        stageColor:paletteState.primary.getHex(),
        coreColor:$player.laser.core.material.color.getHex(),
        coreOpacity:$player.laser.core.material.opacity,
        flash:dom.flash.style.opacity,
      };
      updateLaser(0.1);
      active.laterCoreOpacity=$player.laser.core.material.opacity;
      clearWorldEntities();
      const aligned=Array.from({length:6},(_,index)=>spawnEnemy('chaser',new THREE.Vector2(index+1,0)));
      const offAxis=spawnEnemy('chaser',new THREE.Vector2(2,2));
      const resolved=resolveLaserHits();
      const resolvedAgain=resolveLaserHits();
      const capProbe={
        hitFlags:aligned.map((enemy)=>enemy.dead || enemy.hp<enemy.maxHp),
        sixthHp:aligned[5].hp,
        offAxisHp:offAxis.hp,
        resolved,resolvedAgain,
        hits:$state.stats.laserHits,
        peak:$state.stats.laserPeakTargets,
        feedback:floatingTexts.at(-1)?.element.textContent,
      };
      clearLaserState();
      clearWorldEntities();
      $state.weaponEnergy=100;
      $state.laserState='ready';
      requestLaser();
      attemptLaser();
      $state.laserElapsed=LASER_RULES.chargeDuration;
      updateLaser(0);
      const telegraphingLancer=spawnEnemy('lancer',new THREE.Vector2(2,0));
      telegraphingLancer.hp=3;telegraphingLancer.maxHp=3;
      setEnemyState(telegraphingLancer,'telegraph',0.4,0.4);
      const activeLancer=spawnEnemy('lancer',new THREE.Vector2(3,0));
      setEnemyState(activeLancer,'active',0.4);
      $state.bossSpawned=false;
      const boss=spawnEnemy('boss');
      boss.group.position.set(5,0,2);
      boss.hp=16;
      boss.attackKind='sweepBeam';
      setEnemyState(boss,'execute',0.8);
      const bossBefore=boss.hp;
      const firstCombatResolve=resolveLaserHits();
      const combatProbe={
        lancerHp:telegraphingLancer.hp,
        lancerState:telegraphingLancer.state,
        activeLancerHp:activeLancer.hp,
        activeLancerState:activeLancer.state,
        activeLancerAlive:$enemies.includes(activeLancer),
        bossDamage:bossBefore-boss.hp,
        bossState:boss.state,
        bossPhaseDuringExecute:boss.phase,
        interrupts:$state.stats.laserInterrupts,
      };
      const combatHitsAfterFirst=$state.stats.laserHits;
      combatProbe.secondResolve=resolveLaserHits();
      combatProbe.sameSequenceStable=telegraphingLancer.hp===1&&activeLancer.hp===0&&boss.hp===bossBefore-3&&$state.stats.laserHits===combatHitsAfterFirst;
      combatProbe.firstResolve=firstCombatResolve;
      setEnemyState(boss,'recover',0.8);
      updateBoss(boss,0);
      combatProbe.bossPhaseAfterExecute=boss.phase;
      updateLaser(LASER_RULES.activeDuration+0.01);
      const done={state:$state.laserState,visible:$player.laser.group.visible};
      $state.weaponEnergy=42;
      $state.laserState='active';
      $player.laser.group.visible=true;
      beginUpgrade(1);
      const upgradeCleanup={mode:$state.mode,energy:$state.weaponEnergy,state:$state.laserState,visible:$player.laser.group.visible};
      chooseUpgrade($state.upgradeOptions[0].id);
      $state.weaponEnergy=100;
      $state.laserState='ready';
      requestLaser();attemptLaser();$state.laserElapsed=LASER_RULES.chargeDuration;updateLaser(0);
      pauseGame();
      const pauseCleanup={mode:$state.mode,state:$state.laserState,visible:$player.laser.group.visible};
      resumeGame();
      $state.weaponEnergy=100;
      $state.laserState='ready';
      requestLaser();attemptLaser();$state.laserElapsed=LASER_RULES.chargeDuration;updateLaser(0);
      finishRun('gameover','hullBreach');
      const terminalCleanup={mode:$state.mode,state:$state.laserState,visible:$player.laser.group.visible};
      return {active,capProbe,combatProbe,done,upgradeCleanup,pauseCleanup,terminalCleanup};
    `);
    assert.equal(shot.active.visible, true);
    assert.equal(shot.active.length, 7.2);
    assert.equal(shot.active.width, 0.55);
    assert.equal(shot.active.haloColor, shot.active.stageColor);
    assert.equal(shot.active.coreColor, 0xffffff);
    assert.ok(shot.active.coreOpacity > shot.active.laterCoreOpacity);
    assert.equal(shot.active.flash, '0');
    assert.deepEqual(shot.capProbe.hitFlags, [true,true,true,true,true,false]);
    assert.equal(shot.capProbe.sixthHp, 1);
    assert.equal(shot.capProbe.offAxisHp, 1);
    assert.deepEqual([shot.capProbe.resolved, shot.capProbe.resolvedAgain], [5,0]);
    assert.equal(shot.capProbe.hits, 5);
    assert.equal(shot.capProbe.peak, 5);
    assert.equal(shot.capProbe.feedback, 'PIERCE ×5');
    assert.deepEqual(shot.combatProbe, {
      lancerHp:1,lancerState:'recover',activeLancerHp:0,activeLancerState:'active',activeLancerAlive:true,
      bossDamage:3,bossState:'execute',bossPhaseDuringExecute:1,bossPhaseAfterExecute:2,interrupts:1,
      firstResolve:3,secondResolve:0,sameSequenceStable:true,
    });
    assert.deepEqual(shot.done, { state:'idle', visible:false });
    assert.deepEqual(shot.upgradeCleanup, { mode:'upgrade', energy:42, state:'idle', visible:false });
    assert.deepEqual(shot.pauseCleanup, { mode:'paused', state:'idle', visible:false });
    assert.deepEqual(shot.terminalCleanup, { mode:'gameover', state:'idle', visible:false });
    await page.click('#primary-button');
    await page.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    const restart = await page.gameEvaluate(`return {
      energy:$state.weaponEnergy,state:$state.laserState,visible:$player.laser.group.visible,
      shots:$state.stats.laserShots,hits:$state.stats.laserHits,interrupts:$state.stats.laserInterrupts,peak:$state.stats.laserPeakTargets,
    }`);
    assert.deepEqual(restart, { energy:0,state:'idle',visible:false,shots:0,hits:0,interrupts:0,peak:0 });
  });
}

async function lightLanceCombatContractsScenario() {
  await withPage('light-lance-combat-contracts', {}, async (page) => {
    page.requireDev('light lance damage, quota, execution, recovery, and dash contracts');
    await page.startGame();
    const contracts = await page.gameEvaluate(`
      clearWorldEntities();
      $state.enemySpawnTimer=Infinity;
      $state.formationTimer=Infinity;
      $state.shardSpawnTimer=Infinity;
      $state.health=99;$state.maxHealth=99;$state.hurtInvuln=99;
      $player.position.set(0,0);$player.velocity.set(0,0);$player.facing.set(1,0);syncPlayerTransform();
      const prepareShot=()=>{
        clearLaserState();
        $state.dashTimer=0;$state.dashInvulnTimer=0;
        $state.weaponEnergy=100;$state.laserState='ready';
        requestLaser();attemptLaser();
        $state.laserElapsed=LASER_RULES.chargeDuration;updateLaser(0);
      };
      const damageBatch=(types)=>{
        clearWorldEntities();prepareShot();
        const units=types.map((type,index)=>spawnEnemy(type,new THREE.Vector2(index+1,0)));
        units.forEach((enemy)=>{enemy.hp=10;enemy.maxHp=10;});
        const before=units.map((enemy)=>enemy.hp);
        resolveLaserHits();
        return Object.fromEntries(types.map((type,index)=>[type,before[index]-units[index].hp]));
      };
      const damage={
        ...damageBatch(['chaser','swarm','striker','mine','lancer']),
        ...damageBatch(['bulwark','elite']),
      };
      clearWorldEntities();prepareShot();$state.bossSpawned=false;
      const damageBoss=spawnEnemy('boss');damageBoss.group.position.set(2,0,2);
      const damageBossBefore=damageBoss.hp;resolveLaserHits();damage.boss=damageBossBefore-damageBoss.hp;

      const quotaProbe=(bossAlong)=>{
        clearWorldEntities();prepareShot();$state.bossSpawned=false;
        const ordinary=Array.from({length:6},(_,index)=>spawnEnemy('chaser',new THREE.Vector2(index+1,0)));
        const boss=spawnEnemy('boss');boss.group.position.set(bossAlong,0,2);
        const bossBefore=boss.hp;resolveLaserHits();
        return {
          bossDamage:bossBefore-boss.hp,
          ordinaryHits:ordinary.filter((enemy)=>enemy.dead||enemy.hp<enemy.maxHp).length,
          sixthHp:ordinary[5].hp,
        };
      };
      const bossFirst=quotaProbe(0.5);
      const bossLast=quotaProbe(6.8);

      clearWorldEntities();prepareShot();
      const activeLancer=spawnEnemy('lancer',new THREE.Vector2(1,0));setEnemyState(activeLancer,'active',0.2);updateLancer(activeLancer,0,new THREE.Vector2(-1,0));
      const activeMine=spawnEnemy('mine',new THREE.Vector2(2,0));setEnemyState(activeMine,'detonate',0.2);updateMine(activeMine,0);
      const activeHunter=spawnEnemy('chaser',new THREE.Vector2(3,0));setEnemyState(activeHunter,'charge',0.2);
      const activeStriker=spawnEnemy('striker',new THREE.Vector2(4,0));setEnemyState(activeStriker,'dash',0.2);
      const activeBulwark=spawnEnemy('bulwark',new THREE.Vector2(5,0));activeBulwark.hp=1;setEnemyState(activeBulwark,'shockExecute',0.2);activeBulwark.visuals.shockwave.visible=true;
      resolveLaserHits();
      const executingBeforeTick={
        lancer:{hp:activeLancer.hp,state:activeLancer.state,alive:$enemies.includes(activeLancer),beam:activeLancer.visuals.beam.visible},
        mine:{hp:activeMine.hp,state:activeMine.state,alive:$enemies.includes(activeMine)},
        hunter:{hp:activeHunter.hp,state:activeHunter.state,alive:$enemies.includes(activeHunter)},
        striker:{hp:activeStriker.hp,state:activeStriker.state,alive:$enemies.includes(activeStriker)},
        bulwark:{hp:activeBulwark.hp,state:activeBulwark.state,alive:$enemies.includes(activeBulwark),wave:activeBulwark.visuals.shockwave.visible},
      };
      updateEnemies(0.1);
      const executingMidTick={
        lancer:$enemies.includes(activeLancer)&&activeLancer.state==='active'&&activeLancer.visuals.beam.visible,
        mine:$enemies.includes(activeMine)&&activeMine.state==='detonate',
        hunter:$enemies.includes(activeHunter)&&activeHunter.state==='charge',
        striker:$enemies.includes(activeStriker)&&activeStriker.state==='dash',
        bulwark:$enemies.includes(activeBulwark)&&activeBulwark.state==='shockExecute',
      };
      updateEnemies(1);
      const executingAfter={
        lancer:$enemies.includes(activeLancer),mine:$enemies.includes(activeMine),hunter:$enemies.includes(activeHunter),
        striker:$enemies.includes(activeStriker),bulwark:$enemies.includes(activeBulwark),
      };

      clearWorldEntities();prepareShot();
      const recoveringHunter=spawnEnemy('chaser',new THREE.Vector2(1,0));recoveringHunter.hp=2;recoveringHunter.maxHp=2;setEnemyState(recoveringHunter,'chargeTelegraph',0.5,0.5);
      const recoveringBulwark=spawnEnemy('bulwark',new THREE.Vector2(2,0));setEnemyState(recoveringBulwark,'shockTelegraph',0.5,0.5);recoveringBulwark.visuals.shockwave.visible=true;
      const recoveringLancer=spawnEnemy('lancer',new THREE.Vector2(3,0));recoveringLancer.hp=3;recoveringLancer.maxHp=3;setEnemyState(recoveringLancer,'telegraph',0.5,0.5);
      resolveLaserHits();
      const interrupted={hunter:{hp:recoveringHunter.hp,state:recoveringHunter.state},bulwark:{hp:recoveringBulwark.hp,state:recoveringBulwark.state},lancer:{hp:recoveringLancer.hp,state:recoveringLancer.state}};
      updateChaser(recoveringHunter,0.51,new THREE.Vector2(1,0));
      updateElite(recoveringBulwark,0.51,new THREE.Vector2(1,0));
      updateLancer(recoveringLancer,0.51,new THREE.Vector2(1,0));
      const recovered={hunter:recoveringHunter.state,bulwark:recoveringBulwark.state,lancer:recoveringLancer.state};

      clearWorldEntities();clearLaserState();
      $state.weaponEnergy=100;$state.laserState='ready';$state.dashCharges=[1,1];$state.dashTimer=0;$state.dashInvulnTimer=0;$player.velocity.set(0,0);
      input.laserBuffer=0.14;input.dashBuffer=0.16;attemptLaser();updatePlayer(0.016);
      const sameFrame={laser:$state.laserState,energy:$state.weaponEnergy,dash:$state.dashTimer,invuln:$state.dashInvulnTimer,speed:$player.velocity.length()};
      clearLaserState();$state.weaponEnergy=100;$state.laserState='ready';$state.dashCharges=[1,1];$state.dashTimer=0;$state.dashInvulnTimer=0;$player.velocity.set(0,0);
      const dashStarted=attemptDash(new THREE.Vector2(1,0));requestLaser();const laserDuringDash=attemptLaser();
      const adjacent={dashStarted,laserDuringDash,energy:$state.weaponEnergy,state:$state.laserState,dash:$state.dashTimer,invuln:$state.dashInvulnTimer};
      $state.dashTimer=0;$state.dashInvulnTimer=0;clearLaserState();$state.weaponEnergy=100;$state.laserState='ready';$state.dashCharges=[1,1];$player.velocity.set(10,0);
      const chargeStarted=startLaserCharge();const dashDuringCharge=attemptDash(new THREE.Vector2(1,0));updateLaser(0);
      const chargeFirst={chargeStarted,dashDuringCharge,dash:$state.dashTimer,invuln:$state.dashInvulnTimer,speed:$player.velocity.length()};

      clearWorldEntities();clearLaserState();$state.weaponEnergy=100;$state.laserState='ready';startLaserCharge();
      const lowFrameTarget=spawnEnemy('chaser',new THREE.Vector2(2,0));
      updateLaser(0.3);const lowFrameActive={state:$state.laserState,hp:lowFrameTarget.hp};
      updateLaser(0.3);const lowFrameDone={state:$state.laserState,visible:$player.laser.group.visible};
      return {damage,bossFirst,bossLast,executingBeforeTick,executingMidTick,executingAfter,interrupted,recovered,sameFrame,adjacent,chargeFirst,lowFrameActive,lowFrameDone};
    `);
    assert.deepEqual(contracts.damage, { chaser:1,swarm:1,striker:1,mine:2,lancer:2,bulwark:1,elite:1,boss:3 });
    assert.deepEqual(contracts.bossFirst, { bossDamage:3,ordinaryHits:5,sixthHp:1 });
    assert.deepEqual(contracts.bossLast, { bossDamage:3,ordinaryHits:5,sixthHp:1 });
    assert.deepEqual(contracts.executingBeforeTick, {
      lancer:{hp:0,state:'active',alive:true,beam:true},mine:{hp:-1,state:'detonate',alive:true},hunter:{hp:0,state:'charge',alive:true},
      striker:{hp:0,state:'dash',alive:true},bulwark:{hp:0,state:'shockExecute',alive:true,wave:true},
    });
    assert.deepEqual(contracts.executingMidTick, { lancer:true,mine:true,hunter:true,striker:true,bulwark:true });
    assert.deepEqual(contracts.executingAfter, { lancer:false,mine:false,hunter:false,striker:false,bulwark:false });
    assert.deepEqual(contracts.interrupted, { hunter:{hp:1,state:'recover'},bulwark:{hp:2,state:'recover'},lancer:{hp:1,state:'recover'} });
    assert.deepEqual(contracts.recovered, { hunter:'chase',bulwark:'chase',lancer:'lock' });
    assert.deepEqual(contracts.sameFrame, { laser:'charge',energy:0,dash:0,invuln:0,speed:0 });
    assert.deepEqual(contracts.adjacent, { dashStarted:true,laserDuringDash:false,energy:100,state:'ready',dash:0.19,invuln:0.19 });
    assert.equal(contracts.chargeFirst.chargeStarted, true);
    assert.equal(contracts.chargeFirst.dashDuringCharge, false);
    assert.equal(contracts.chargeFirst.dash, 0);
    assert.equal(contracts.chargeFirst.invuln, 0);
    assert.ok(Math.abs(contracts.chargeFirst.speed-4.92)<0.001, `charge speed ${contracts.chargeFirst.speed}`);
    assert.deepEqual(contracts.lowFrameActive, { state:'active',hp:0 });
    assert.deepEqual(contracts.lowFrameDone, { state:'idle',visible:false });
  });
}

async function naturalLightLanceLifecycleScenario() {
  await withPage('natural-light-lance-lifecycle', {}, async (page) => {
    page.requireDev('natural light lance lifecycle and boundary input probe');
    await page.startGame();
    await page.gameEvaluate(`
      clearWorldEntities();
      $state.enemySpawnTimer=Infinity;$state.formationTimer=Infinity;$state.shardSpawnTimer=Infinity;
      $player.position.set(0,0);$player.velocity.set(0,0);$player.facing.set(1,0);syncPlayerTransform();
      for(let index=0;index<20;index+=1){spawnShard($player.position.clone());collectShard(shards.length-1)}
      return {energy:$state.weaponEnergy,state:$state.laserState};
    `);
    await page.pressKey('e', 'KeyE');
    await page.waitForPage(`document.querySelector('#laser-status').textContent.includes('蓄力')`, 1500);
    const naturalCharge = await page.evaluate(`({status:document.querySelector('#laser-status').textContent,energy:document.querySelector('#weapon-energy-value').textContent})`);
    assert.deepEqual(naturalCharge, { status:'光矛 // 蓄力',energy:'0' });
    await page.waitForPage(`document.querySelector('#laser-status').textContent.includes('发射')`, 1500);
    await page.waitForPage(`document.querySelector('#laser-status').textContent.includes('充能中 0%')`, 1800);
    const naturalDone = await page.gameEvaluate(`return {state:$state.laserState,shots:$state.stats.laserShots,visible:$player.laser.group.visible}`);
    assert.deepEqual(naturalDone, { state:'idle',shots:1,visible:false });

    await page.gameEvaluate(`
      $state.weaponEnergy=100;$state.laserState='ready';$state.dashCharges=[1,1];$state.dashTimer=0;$state.dashInvulnTimer=0;
      input.dashBuffer=0;input.laserBuffer=0;$player.velocity.set(0,0);return true;
    `);
    await page.dispatchKey('rawKeyDown','e','KeyE');
    await page.dispatchKey('rawKeyDown',' ','Space');
    await page.dispatchKey('keyUp','e','KeyE');
    await page.dispatchKey('keyUp',' ','Space');
    await page.waitForPage(`document.querySelector('#laser-status').textContent.includes('蓄力')`, 1500);
    const sameFrame = await page.gameEvaluate(`return {state:$state.laserState,dash:$state.dashTimer,invuln:$state.dashInvulnTimer,charges:[...$state.dashCharges]}`);
    assert.deepEqual(sameFrame, { state:'charge',dash:0,invuln:0,charges:[1,1] });
    await page.waitForPage(`document.querySelector('#laser-status').textContent.includes('充能中 0%')`, 1800);

    await page.gameEvaluate(`
      $state.weaponEnergy=100;$state.laserState='ready';$state.dashCharges=[1,1];$state.dashTimer=0;$state.dashInvulnTimer=0;
      input.dashBuffer=0;input.laserBuffer=0;$player.velocity.set(0,0);return true;
    `);
    await page.pressKey(' ', 'Space');
    await sleep(20);
    await page.pressKey('e', 'KeyE');
    await sleep(20);
    const adjacent = await page.gameEvaluate(`return {energy:$state.weaponEnergy,state:$state.laserState,dash:$state.dashTimer,invuln:$state.dashInvulnTimer}`);
    assert.equal(adjacent.energy, 100);
    assert.equal(adjacent.state, 'ready');
    assert.ok(adjacent.dash > 0 && adjacent.invuln > 0, `adjacent dash was not retained: ${JSON.stringify(adjacent)}`);

    await sleep(260);
    const shotsBeforeThirty = await page.gameEvaluate(`
      $state.elapsed=29.97;$state.stageIndex=0;$state.stageQueue=[];$state.upgradeTriggered=[false,false];
      $state.weaponEnergy=100;$state.laserState='ready';input.laserBuffer=0;return $state.stats.laserShots;
    `);
    await page.pressKey('e', 'KeyE');
    await page.waitForPage(`!document.querySelector('#upgrade-panel').hidden`, 1800);
    const boundaryThirty = await page.evaluate(`({energy:document.querySelector('#weapon-energy-value').textContent,status:document.querySelector('#laser-status').textContent})`);
    assert.deepEqual(boundaryThirty, { energy:'100',status:'光矛 // READY' });
    await page.click('.upgrade-option');
    await page.waitForPage(`document.querySelector('#upgrade-panel').hidden`);
    assert.equal(await page.gameEvaluate(`return $state.stats.laserShots`), shotsBeforeThirty);

    const shotsBeforeSixtyFour = await page.gameEvaluate(`
      $state.elapsed=63.97;$state.stageIndex=1;$state.stageQueue=[];$state.upgradeTriggered=[true,false];
      $state.weaponEnergy=100;$state.laserState='ready';input.laserBuffer=0;return $state.stats.laserShots;
    `);
    await page.pressKey('e', 'KeyE');
    await page.waitForPage(`!document.querySelector('#upgrade-panel').hidden`, 1800);
    const boundarySixtyFour = await page.evaluate(`({energy:document.querySelector('#weapon-energy-value').textContent,status:document.querySelector('#laser-status').textContent})`);
    assert.deepEqual(boundarySixtyFour, { energy:'100',status:'光矛 // READY' });
    assert.equal(await page.gameEvaluate(`return $state.stats.laserShots`), shotsBeforeSixtyFour);
  });
}

function layoutSnapshotExpression() {
  return `(()=>{
    const rect=(selector)=>{const e=document.querySelector(selector),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,display:s.display,visibility:s.visibility}};
    const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    const mission=rect('#mission-panel'),joystick=rect('#joystick'),dash=rect('#dash-button'),laser=rect('#laser-button'),hud=rect('#hud'),touch=rect('#touch-controls');
    return {
      coarse:matchMedia('(pointer: coarse)').matches,
      touchPoints:navigator.maxTouchPoints,
      size:[innerWidth,innerHeight],
      overflow:[document.documentElement.scrollWidth-innerWidth,document.documentElement.scrollHeight-innerHeight],
      mission,joystick,dash,laser,hud,touch,
      missionJoystickOverlap:overlap(mission,joystick),
      missionDashOverlap:overlap(mission,dash),
      missionLaserOverlap:overlap(mission,laser),
      objective:document.querySelector('#mission-objective').textContent.trim(),
      energyVisible:getComputedStyle(document.querySelector('.energy-track')).display!=='none',
      laserStatusVisible:getComputedStyle(document.querySelector('#laser-status')).display!=='none',
    };
  })()`;
}

async function coarseLayoutScenario(name, width, height, deviceScaleFactor) {
  await withPage(name, { width, height, deviceScaleFactor, mobile: true, touch: true }, async (page) => {
    await page.startGame();
    const layout = await page.evaluate(layoutSnapshotExpression());
    assert.equal(layout.coarse, true, `${name}: pointer is not coarse`);
    assert.ok(layout.touchPoints > 0, `${name}: touch emulation missing`);
    assert.deepEqual(layout.size, [width, height]);
    assert.ok(layout.overflow[0] <= 0 && layout.overflow[1] <= 0, `${name}: document overflow ${layout.overflow}`);
    assert.notEqual(layout.mission.display, 'none', `${name}: mission panel hidden`);
    assert.notEqual(layout.touch.display, 'none', `${name}: touch controls hidden`);
    assert.ok(layout.objective.length > 0 && layout.energyVisible && layout.laserStatusVisible, `${name}: compact mission status incomplete`);
    assert.equal(layout.missionJoystickOverlap, 0, `${name}: mission overlaps joystick by ${layout.missionJoystickOverlap}px²`);
    assert.equal(layout.missionDashOverlap, 0, `${name}: mission overlaps dash by ${layout.missionDashOverlap}px²`);
    assert.equal(layout.missionLaserOverlap, 0, `${name}: mission overlaps laser by ${layout.missionLaserOverlap}px²`);
    for (const [elementName, rect] of [['mission', layout.mission], ['joystick', layout.joystick], ['dash', layout.dash], ['laser', layout.laser]]) {
      assert.ok(rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= width + 0.5 && rect.bottom <= height + 0.5,
        `${name}: ${elementName} outside viewport ${JSON.stringify(rect)}`);
    }
    page.requireDev('coarse-pointer combat cap probe');
    const cap = await page.gameEvaluate(`
      clearWorldEntities();
      for (let index=0; index<50; index+=1) spawnEnemy('chaser');
      return {cap:getEnemyCap(),count:$enemies.length,peak:$state.stats.enemyPeak};
    `);
    assert.equal(cap.cap, 32, `${name}: coarse enemy cap changed`);
    assert.ok(cap.count <= cap.cap && cap.peak <= cap.cap, `${name}: coarse cap exceeded ${JSON.stringify(cap)}`);
  });
}


async function highPressureCombatScenario() {
  await withPage('high-pressure-combat', {}, async (page) => {
    page.requireDev('high-pressure combat statistics probe');
    await page.startGame();
    const snapshot = await page.gameEvaluate(`
      clearWorldEntities();
      $state.stageIndex=0;
      $state.elapsed=0;
      $state.enemySpawnTimer=0.72;
      $state.formationTimer=5.4;
      const spawnTimerStart=$state.enemySpawnTimer;
      const formationTimerStart=$state.formationTimer;
      updateSpawning(0.1);
      const timerProbe={spawn:$state.enemySpawnTimer,formation:$state.formationTimer};
      $state.enemySpawnTimer=0;
      $state.formationTimer=0;
      for (let tick=0; tick<30; tick+=1) {
        $state.elapsed=tick;
        if (tick > 0 && tick % 6 === 0) $state.formationTimer=0;
        updateSpawning(0.1);
      }
      const firstThirty={formations:$state.stats.formationCount,peak:$state.stats.enemyPeak,roles:{...$state.stats.roles}};
      clearWorldEntities();
      $state.stageIndex=1;
      $state.elapsed=42;
      $state.formationTimer=0;
      updateSpawning(0.1);
      const stageTwo={formations:$state.stats.formationCount,log:[...$state.stats.formationLog]};
      clearWorldEntities();
      $state.stageIndex=2;
      $state.elapsed=80;
      $state.formationTimer=0;
      updateSpawning(0.1);
      const stageThree={formations:$state.stats.formationCount,log:[...$state.stats.formationLog]};
      clearWorldEntities();
      $state.health=3;
      $state.hurtInvuln=0;
      $state.dashInvulnTimer=0;
      const lancer=spawnEnemy('lancer',new THREE.Vector2(0,0));
      lancer.state='active';
      lancer.stateTimer=0.65;
      lancer.beamDirection.set(1,0);
      $player.position.set(3,0);
      syncPlayerTransform();
      const healthBefore=$state.health;
      updateEnemies(0.016);
      const beamCollision={healthBefore,healthAfter:$state.health,hazards:$state.stats.activeHazards,beamPeak:$state.stats.beamPeak};
      const lancerActive=lancer.state==='active' && lancer.visuals.beam.visible;
      const roles={...$state.stats.roles};
      const peak=$state.stats.enemyPeak;
      clearWorldEntities();
      return {spawnTimerStart,formationTimerStart,timerProbe,firstThirty,stageTwo,stageThree,lancerActive,beamCollision,roles,peak,afterCleanup:$state.stats.activeCleanupCount,activeEnemies:$enemies.length};
    `);
    assert.ok(snapshot.timerProbe.spawn < snapshot.spawnTimerStart && snapshot.timerProbe.formation < snapshot.formationTimerStart, `director timers did not count down: ${JSON.stringify(snapshot.timerProbe)}`);
    assert.ok(snapshot.firstThirty.peak >= 8, `enemy density too low in first 30s: ${snapshot.firstThirty.peak}`);
    assert.ok(snapshot.firstThirty.formations >= 2, `first 30s formations: ${snapshot.firstThirty.formations}`);
    assert.ok(Object.keys(snapshot.firstThirty.roles).length >= 2, `first 30s roles: ${JSON.stringify(snapshot.firstThirty.roles)}`);
    assert.equal(snapshot.firstThirty.roles.Striker ?? 0, 0, `stage 1 leaked Striker: ${JSON.stringify(snapshot.firstThirty.roles)}`);
    assert.equal(snapshot.firstThirty.roles.Lancer ?? 0, 0, `stage 1 leaked Lancer: ${JSON.stringify(snapshot.firstThirty.roles)}`);
    assert.equal(snapshot.firstThirty.roles.Bulwark ?? 0, 0, `stage 1 leaked Bulwark: ${JSON.stringify(snapshot.firstThirty.roles)}`);
    assert.ok(snapshot.stageTwo.formations >= snapshot.firstThirty.formations + 1, 'stage 2 formation did not fire');
    assert.ok(snapshot.stageThree.formations >= snapshot.stageTwo.formations + 1, 'stage 3 formation did not fire');
    assert.equal(snapshot.lancerActive, true, 'lancer beam telegraph/active lifecycle did not run');
    assert.ok(snapshot.beamCollision.healthAfter < snapshot.beamCollision.healthBefore, `beam did not collide: ${JSON.stringify(snapshot.beamCollision)}`);
    assert.ok(snapshot.beamCollision.hazards >= 1 && snapshot.beamCollision.beamPeak >= 1, `beam hazard stats missing: ${JSON.stringify(snapshot.beamCollision)}`);
    assert.ok(snapshot.roles.Lancer >= 1, `lancer role missing: ${JSON.stringify(snapshot.roles)}`);
    assert.ok(snapshot.afterCleanup > 0 && snapshot.activeEnemies === 0, 'combat cleanup left orphan enemies');
  });
}

async function reviewedCombatContractsScenario() {
  await withPage('reviewed-combat-contracts', {}, async (page) => {
    page.requireDev('beam, material ownership, armor, mine pulse, and enemy trail contracts');
    await page.startGame();
    const contracts = await page.gameEvaluate(`
      clearWorldEntities();
      const mine=createMine(new THREE.Vector2(-2,0));
      const lancer=createLancer(new THREE.Vector2(0,0));
      const elite=createElite(new THREE.Vector2(2,0));
      $state.bossSpawned=false;
      const boss=createBoss();
      const materials={
        mine:mine.visuals.ring.material!==shared.dangerRingMaterial && mine.visuals.tick.material!==shared.warningRingMaterial,
        lancer:lancer.visuals.line.material!==shared.lancerTelegraphMaterial && lancer.visuals.beam.material!==shared.lancerBeamMaterial,
        elite:elite.visuals.shockwave.material!==shared.dangerRingMaterial,
        boss:boss.visuals.line.material!==shared.telegraphMaterial && boss.visuals.core.material!==shared.coreMaterial && boss.visuals.coreGlow.material!==shared.bossCoreGlowMaterial,
      };
      lancer.state='active';
      lancer.stateTimer=0.35;
      lancer.beamDirection.set(1,0);
      updateLancer(lancer,0);
      boss.state='execute';
      boss.attackKind='sweepBeam';
      boss.stateTimer=0.58;
      updateBoss(boss,0);
      const beams={
        lancer:{mesh:lancer.visuals.beam.isMesh,width:lancer.beamWidth,scale:lancer.visuals.beam.scale.x},
        boss:{mesh:boss.visuals.line.isMesh,width:boss.beamWidth,scale:boss.visuals.line.scale.x},
      };
      elite.state='chase';
      elite.stateTimer=1;
      elite.shockTimer=-0.01;
      elite.pulseHit=true;
      updateElite(elite,0,new THREE.Vector2(1,0));
      const eliteContract={hp:elite.hp,state:elite.state,pulseHit:elite.pulseHit};
      const mineStages=[];
      mine.state='detonate';
      for(const remaining of [0.77,0.51,0.25]){
        mine.stateTimer=remaining;
        updateMine(mine,0);
        mineStages.push({stage:mine.detonationStage,radius:mine.dangerRadius});
      }
      const trailCount=trails.length;
      const striker=createStriker(new THREE.Vector2(0,-2));
      striker.state='telegraph';
      striker.stateTimer=0;
      striker.dashDirection.set(1,0);
      updateStriker(striker,0);
      const strikerTrailDelta=trails.length-trailCount;
      return {materials,beams,eliteContract,mineStages,strikerTrailDelta};
    `);
    assert.deepEqual(contracts.materials, { mine:true, lancer:true, elite:true, boss:true });
    assert.deepEqual(contracts.beams.lancer, { mesh:true, width:contracts.beams.lancer.width, scale:contracts.beams.lancer.width });
    assert.deepEqual(contracts.beams.boss, { mesh:true, width:contracts.beams.boss.width, scale:contracts.beams.boss.width });
    assert.deepEqual(contracts.eliteContract, { hp:3, state:'shockTelegraph', pulseHit:false });
    assert.deepEqual(contracts.mineStages.map(({ stage }) => stage), [0,1,2]);
    assert.ok(contracts.mineStages[0].radius < contracts.mineStages[1].radius && contracts.mineStages[1].radius < contracts.mineStages[2].radius);
    assert.equal(contracts.strikerTrailDelta, 0);
  });
}

async function reducedMotionScenario() {
  await withPage('reduced-motion', { reducedMotion: true }, async (page) => {
    page.requireDev('reduced-motion warning probe');
    await page.startGame();
    assert.equal(await page.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
    assert.equal(await page.gameEvaluate('return $state.reducedMotion'), true);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.signal-mark i')).animationName`), 'none');

    const warnings = await page.gameEvaluate(`
      clearWorldEntities();
      const mine=createMine();
      mine.state='arming';
      mine.stateTimer=1.2;
      updateMine(mine,0);
      const mineEarly={color:mine.visuals.ring.material.color.getHex(),opacity:mine.visuals.ring.material.opacity,scale:mine.visuals.ring.scale.x};
      mine.stateTimer=0.08;
      updateMine(mine,0);
      const mineLate={color:mine.visuals.ring.material.color.getHex(),opacity:mine.visuals.ring.material.opacity,scale:mine.visuals.ring.scale.x};
      removeEnemy($enemies.indexOf(mine));
      $state.bossSpawned=false;
      const boss=createBoss();
      boss.state='telegraph';
      boss.attackKind='pulse';
      boss.visuals.pulseRing.visible=true;
      boss.stateTimer=0.6;
      updateBoss(boss,0);
      const bossEarly={color:boss.visuals.pulseRing.material.color.getHex(),opacity:boss.visuals.pulseRing.material.opacity,scale:boss.visuals.pulseRing.scale.x};
      boss.stateTimer=0.04;
      updateBoss(boss,0);
      const bossLate={color:boss.visuals.pulseRing.material.color.getHex(),opacity:boss.visuals.pulseRing.material.opacity,scale:boss.visuals.pulseRing.scale.x};
      triggerFeedback('large',{position:$player.position,color:0x64f5ff,text:'REDUCED'});
      $state.dashCharges=[1,1];
      $state.dashTimer=0;
      attemptDash(new THREE.Vector2(0,1));
      return {
        mineEarly,mineLate,bossEarly,bossLate,
        slowTimer:$state.slowMotionTimer,slowScale:$state.slowMotionScale,trauma:$state.trauma,zoom:$state.zoomPunch,
        trails:trails.length,playerScale:[$player.group.scale.x,$player.group.scale.y],
      };
    `);
    assert.notDeepEqual(warnings.mineEarly, warnings.mineLate, 'reduced-motion mine warning did not progress');
    assert.notDeepEqual(warnings.bossEarly, warnings.bossLate, 'reduced-motion boss warning did not progress');
    assert.ok(warnings.mineLate.opacity > warnings.mineEarly.opacity, 'mine warning did not intensify');
    assert.ok(warnings.bossLate.opacity > warnings.bossEarly.opacity, 'boss warning did not intensify');
    assert.equal(warnings.slowTimer, 0);
    assert.equal(warnings.slowScale, 1);
    assert.equal(warnings.trauma, 0);
    assert.equal(warnings.zoom, 0);
    assert.equal(warnings.trails, 0);
    assert.deepEqual(warnings.playerScale, [0.88, 0.88]);
  });
}

async function renderQualityScenario() {
  await withPage('render-quality-desktop', {}, async (page) => {
    page.requireDev('desktop render-quality probe');
    await page.startGame();
    const quality = await page.gameEvaluate(`return {
      tier:document.documentElement.dataset.renderQuality,
      selected:renderQuality.tier,
      composer:Boolean(postProcessing && postProcessing.enabled),
      bloom:Boolean(postProcessing && postProcessing.bloomPass),
      output:Boolean(postProcessing && postProcessing.outputPass),
    }`);
    assert.deepEqual(quality, { tier:'desktop', selected:'desktop', composer:true, bloom:true, output:true });
  });

  await withPage('render-quality-coarse', { width:1024, height:768, mobile:true, touch:true }, async (page) => {
    page.requireDev('coarse render-quality probe');
    await page.startGame();
    const quality = await page.gameEvaluate(`return {
      tier:document.documentElement.dataset.renderQuality,
      selected:renderQuality.tier,
      composer:Boolean(postProcessing && postProcessing.enabled),
    }`);
    assert.deepEqual(quality, { tier:'mobile', selected:'mobile', composer:false });
  });

  await withPage('render-quality-reduced-motion', { reducedMotion:true }, async (page) => {
    page.requireDev('reduced-motion render-quality probe');
    await page.startGame();
    const quality = await page.gameEvaluate(`return {
      tier:document.documentElement.dataset.renderQuality,
      selected:renderQuality.tier,
      composer:Boolean(postProcessing && postProcessing.enabled),
    }`);
    assert.deepEqual(quality, { tier:'reduced-motion', selected:'reduced-motion', composer:false });
  });
}

async function realmArtDirectionsScenario() {
  let desktopObjectCounts = null;
  await withPage('realm-art-directions-desktop', {}, async (page) => {
    page.requireDev('realm art direction boundary and lifecycle probes');
    await page.startGame();
    const realms = [];
    for (let index = 0; index < 4; index += 1) {
      const entry = await page.gameEvaluate(`
        const controller=typeof realmBackgrounds==='undefined' ? null : realmBackgrounds;
        $state.upgradeTriggered=[true,true];
        $state.bossTriggered=true;
        $state.stageQueue=[];
        $state.elapsed=REALMS[${index}].start;
        if(${index}===0){
          $state.stageIndex=0;
          if(controller) enterStage(0);
          else setPalette(0,true);
        }else{
          $state.stageIndex=${index - 1};
          $state.mode='playing';
          updateStage();
        }
        $state.mode='paused';
        const before=controller?.getStats() ?? {updateCounts:[0,0,0,0]};
        controller?.update({elapsed:$state.elapsed,dt:0.016,reducedMotion:$state.reducedMotion});
        const after=controller?.getStats() ?? {
          activeRealm:$state.stageIndex,
          visibleGroups:0,
          updateCounts:[0,0,0,0],
          objectCounts:[0,0,0,0],
          disposed:false,
        };
        const root=scene.children.find((child)=>child.userData?.realmBackgroundRoot);
        const sampleGroups=root
          ? root.children.filter((child)=>child.visible)
          : [backgroundGroup,starsGroup,decorGroup];
        const signatureParts=[];
        let fallbackObjectCount=0;
        sampleGroups.forEach((sampleGroup)=>sampleGroup.traverse((object)=>{
          if(!object.geometry) return;
          fallbackObjectCount+=1;
          const positionCount=object.geometry.attributes?.position?.count ?? 0;
          const indexCount=object.geometry.index?.count ?? 0;
          signatureParts.push([object.type,object.geometry.type,positionCount,indexCount].join(':'));
        }));
        return {
          activeRealm:after.activeRealm,
          boundary:$state.elapsed,
          dataset:document.documentElement.dataset.realm ?? null,
          visibleGroups:after.visibleGroups,
          signature:signatureParts.sort().join('|'),
          inactiveUpdates:after.updateCounts.reduce((total,count,realmIndex)=>
            total+(realmIndex===after.activeRealm ? 0 : count-(before.updateCounts[realmIndex] ?? 0)),0),
          objectCounts:controller ? after.objectCounts : [fallbackObjectCount,fallbackObjectCount,fallbackObjectCount,fallbackObjectCount],
        };
      `);
      realms.push(entry);
      assert.equal(entry.boundary, [0, 30, 64, 100][index], `realm ${index} did not start at its exact boundary`);
      assert.equal(entry.activeRealm, index, `realm ${index} did not become active`);
      if (REALM_SCREENSHOT_DIR) {
        await sleep(80);
        await page.captureScreenshot(path.join(
          REALM_SCREENSHOT_DIR,
          `realm-${String(index + 1).padStart(2, '0')}-${['abyss', 'data-city', 'star-forge', 'void-cathedral'][index]}.png`,
        ));
      }
    }

    assert.deepEqual(realms.map((entry) => entry.dataset), ['abyss','data-city','star-forge','void-cathedral']);
    assert.ok(realms.every((entry) => entry.visibleGroups === 1));
    assert.equal(new Set(realms.map((entry) => entry.signature)).size, 4);
    assert.ok(realms.every((entry) => entry.inactiveUpdates === 0));
    desktopObjectCounts = realms[0].objectCounts;

    const reducedSwap = await page.gameEvaluate(`
      const controller=typeof realmBackgrounds==='undefined' ? null : realmBackgrounds;
      if(!controller) return {supported:false};
      applyReducedMotionPreference(true);
      $state.elapsed=REALMS[1].start;
      enterStage(1);
      const stats=controller.getStats();
      const root=scene.children.find((child)=>child.userData?.realmBackgroundRoot);
      const active=root?.children.find((child)=>child.visible);
      const lineLayers=active?.children.filter((child)=>child.isLineSegments) ?? [];
      return {
        supported:true,
        activeRealm:stats.activeRealm,
        dataset:document.documentElement.dataset.realm,
        visibleGroups:stats.visibleGroups,
        scale:[active?.scale.x,active?.scale.y],
        skylineX:lineLayers.slice(0,3).map((line)=>line.position.x),
        laneY:lineLayers[3]?.position.y,
      };
    `);
    assert.deepEqual(reducedSwap, {
      supported:true,
      activeRealm:1,
      dataset:'data-city',
      visibleGroups:1,
      scale:[1,1],
      skylineX:[0,0,0],
      laneY:0,
    });

    const lifecycle = await page.gameEvaluate(`
      const controller=typeof realmBackgrounds==='undefined' ? null : realmBackgrounds;
      const root=scene.children.find((child)=>child.userData?.realmBackgroundRoot);
      if(!controller || !root) return {supported:false};
      const before=controller.getStats();
      controller.resize(640,960);
      const resized=controller.getStats();
      controller.setRealm(2,true);
      const repeatedBefore=controller.getStats();
      controller.setRealm(2,true);
      const repeatedAfter=controller.getStats();
      controller.reset();
      const reset=controller.getStats();
      const resources=new Set();
      root.traverse((object)=>{
        if(object.geometry) resources.add(object.geometry);
        const objectMaterials=Array.isArray(object.material) ? object.material : [object.material];
        objectMaterials.filter(Boolean).forEach((material)=>resources.add(material));
      });
      const disposeCounts=[];
      for(const resource of resources){
        const original=resource.dispose.bind(resource);
        let count=0;
        resource.dispose=()=>{count+=1;disposeCounts.push(resource);original();};
        resource.userData.__realmDisposeCount=()=>count;
      }
      controller.dispose();
      controller.dispose();
      const counts=[...resources].map((resource)=>resource.userData.__realmDisposeCount());
      const disposed=controller.getStats();
      return {
        supported:true,
        countsStable:JSON.stringify(before.objectCounts)===JSON.stringify(resized.objectCounts),
        repeatedStable:JSON.stringify(repeatedBefore)===JSON.stringify(repeatedAfter),
        resetActive:reset.activeRealm,
        resetVisible:reset.visibleGroups,
        resourceCount:resources.size,
        disposeCalls:disposeCounts.length,
        disposed:disposed.disposed,
        detached:!scene.children.includes(root),
        once:counts.every((count)=>count===1),
      };
    `);
    assert.deepEqual(lifecycle, {
      supported:true,
      countsStable:true,
      repeatedStable:true,
      resetActive:0,
      resetVisible:1,
      resourceCount:lifecycle.resourceCount,
      disposeCalls:lifecycle.resourceCount,
      disposed:true,
      detached:true,
      once:true,
    });
    assert.ok(lifecycle.resourceCount > 0, 'realm controller did not own any disposable resources');
  });

  let mobileObjectCounts = null;
  await withPage('realm-art-directions-coarse', {
    width: 1024,
    height: 768,
    mobile: true,
    touch: true,
  }, async (page) => {
    page.requireDev('coarse realm art direction budget probe');
    await page.startGame();
    mobileObjectCounts = await page.gameEvaluate(`
      return typeof realmBackgrounds==='undefined' ? null : realmBackgrounds.getStats().objectCounts;
    `);
  });
  assert.ok(Array.isArray(desktopObjectCounts) && Array.isArray(mobileObjectCounts));
  assert.equal(desktopObjectCounts.length, 4);
  assert.equal(mobileObjectCounts.length, 4);
  desktopObjectCounts.forEach((count, index) => {
    assert.ok(mobileObjectCounts[index] < count,
      `coarse realm ${index} object count ${mobileObjectCounts[index]} was not below desktop ${count}`);
  });
}

async function runtimeGuardScenario() {
  await withPage('runtime-guards', {}, async (page) => {
    page.requireDev('runtime guard, cap, and listener lifecycle probe');
    await page.startGame();
    const injected = await page.gameEvaluate(`
      const before={setup:runtimeStats.inputSetupCount,refresh:runtimeStats.composerRefreshCount};
      const pools={particles:particlePool.length,trails:trailPool.length};
      const runtimeHooks=globalThis.__NEON_TIDE_RUNTIME_HOOKS__;
      runtimeHooks.createParticlePool();
      runtimeHooks.createTrailPool();
      runtimeHooks.setupInput();
      runtimeHooks.setupInput();
      clearWorldEntities();
      const bad=spawnEnemy('chaser',new THREE.Vector2(0,0));
      bad.group.position.x=NaN;
      bad.velocity.y=Infinity;
      const missingVelocity=spawnEnemy('chaser',new THREE.Vector2(0,0));
      delete missingVelocity.velocity;
      $enemies.push({type:'orphan',dead:false,velocity:null});
      $player.position.x=NaN;
      $state.enemySpawnTimer=Infinity;
      const badParticle=particlePool[0];
      badParticle.mesh.visible=true;
      badParticle.mesh.position.x=NaN;
      badParticle.mesh.scale.y=Infinity;
      badParticle.mesh.material.opacity=Infinity;
      badParticle.life=0.2;
      badParticle.maxLife=0.4;
      badParticle.velocity.x=NaN;
      particles.push(badParticle);
      const missingMaterial=particlePool[1];
      missingMaterial.mesh.visible=true;
      delete missingMaterial.mesh.material;
      missingMaterial.life=0.2;
      missingMaterial.maxLife=0.4;
      particles.push(missingMaterial);
      const badTrail=trailPool[0];
      badTrail.group.visible=true;
      badTrail.life=NaN;
      badTrail.maxLife=Infinity;
      badTrail.group.position.x=Infinity;
      badTrail.group.scale.y=NaN;
      badTrail.group.rotation.z=Infinity;
      badTrail.meshes[0].material.opacity=NaN;
      trails.push(badTrail);
      return {before,pools,afterPools:{particles:particlePool.length,trails:trailPool.length},afterSetup:runtimeStats.inputSetupCount};
    `);
    assert.equal(injected.afterSetup, injected.before.setup, 'reopening input duplicated listeners');
    assert.deepEqual(injected.afterPools, injected.pools, 'reopening pools duplicated geometry/materials');
    await sleep(100);
    const healed = await page.gameEvaluate(`return {
      guards:runtimeStats.finiteGuards,
      orphans:runtimeStats.orphanGuards,
      cleanup:$state.stats.activeCleanupCount,
      enemies:$enemies.length,
      playerFinite:Number.isFinite($player.position.x)&&Number.isFinite($player.position.y),
      spawnSentinel:Number.isFinite($state.enemySpawnTimer)?'finite':String($state.enemySpawnTimer),
      particles:particles.length,
      trails:trails.length,
      retiredTrail:trailPool[0] ? {
        visible:trailPool[0].group.visible,
        life:trailPool[0].life,
        maxLife:trailPool[0].maxLife,
        transform:[trailPool[0].group.position.x,trailPool[0].group.scale.y,trailPool[0].group.rotation.z],
        opacity:trailPool[0].meshes[0].material.opacity,
      } : null,
    }`);
    assert.ok(healed.guards > 0, `finite guard did not run: ${JSON.stringify(healed)}`);
    assert.ok(healed.orphans > 0 && healed.cleanup > 0, `orphan entity was not cleaned: ${JSON.stringify(healed)}`);
    assert.equal(healed.enemies, 0);
    assert.equal(healed.playerFinite, true);
    assert.equal(healed.spawnSentinel, 'Infinity');
    assert.ok(healed.particles <= 300 && healed.trails <= 48);
    assert.ok(healed.particles === 0, `malformed particle remained active: ${JSON.stringify(healed)}`);
    assert.deepEqual(healed.retiredTrail, { visible:false, life:0, maxLife:0, transform:[0,1,0], opacity:0 });
    const qualityLifecycle = await page.gameEvaluate(`const before={dispose:runtimeStats.composerDisposeCount,refresh:runtimeStats.composerRefreshCount};const runtimeHooks=globalThis.__NEON_TIDE_RUNTIME_HOOKS__;runtimeHooks.applyReducedMotionPreference(true);const reduced={tier:renderQuality.tier,composer:Boolean(postProcessing?.enabled)};runtimeHooks.applyReducedMotionPreference(false);const desktop={tier:renderQuality.tier,composer:Boolean(postProcessing?.enabled)};return {before,reduced,desktop,dispose:runtimeStats.composerDisposeCount,refresh:runtimeStats.composerRefreshCount}`);
    assert.deepEqual(qualityLifecycle.reduced, { tier:'reduced-motion', composer:false });
    assert.deepEqual(qualityLifecycle.desktop, { tier:'desktop', composer:true });
    assert.ok(qualityLifecycle.dispose >= qualityLifecycle.before.dispose + 2, `quality lifecycle did not dispose/recreate: ${JSON.stringify(qualityLifecycle)}`);
    assert.equal(qualityLifecycle.refresh, qualityLifecycle.before.refresh + 2, `quality lifecycle did not refresh exactly twice: ${JSON.stringify(qualityLifecycle)}`);
    // Exercise first allocation with hostile counts; pools must never exceed their hard caps.
    const overCapacity = await page.gameEvaluate(`for(const particle of particlePool){world.remove(particle.mesh);particle.mesh.material.dispose()}particlePool.length=0;for(const trail of trailPool){world.remove(trail.group);trail.meshes.forEach((mesh)=>mesh.material.dispose())}trailPool.length=0;const runtimeHooks=globalThis.__NEON_TIDE_RUNTIME_HOOKS__;runtimeHooks.createParticlePool(9999);runtimeHooks.createTrailPool(Infinity);return {particles:particlePool.length,trails:trailPool.length}`);
    assert.deepEqual(overCapacity, { particles:300, trails:48 });
    const resized = await page.gameEvaluate(`const before=runtimeStats.composerRefreshCount;globalThis.__NEON_TIDE_RUNTIME_HOOKS__.resize();return {before,after:runtimeStats.composerRefreshCount}`);
    assert.deepEqual(resized, { before: qualityLifecycle.refresh, after: qualityLifecycle.refresh }, 'resize recreated Composer');
  });
}

async function repairAndAriaScenario() {
  await withPage('repair-aria', {}, async (page) => {
    page.requireDev('Repair Swarm and combat ARIA probe');
    await page.startGame();
    const repair = await page.gameEvaluate(`
      $state.maxHealth=3;
      $state.health=3;
      $state.ownedUpgrades=[];
      const applied=applyUpgrade('repair-swarm');
      syncHealthPips();
      return {
        applied,maxHealth:$state.maxHealth,health:$state.health,pips:dom.healthPips.length,
        now:dom.health.getAttribute('aria-valuenow'),max:dom.health.getAttribute('aria-valuemax'),text:dom.health.getAttribute('aria-valuetext'),
      };
    `);
    assert.deepEqual(repair, {
      applied: true,
      maxHealth: 4,
      health: 4,
      pips: 4,
      now: '4',
      max: '4',
      text: '船体 4 / 4',
    });

    const bossAria = await page.gameEvaluate(`
      clearWorldEntities();
      $state.bossSpawned=false;
      const boss=createBoss();
      syncBossProgress(boss);
      const before={now:dom.bossTrack.getAttribute('aria-valuenow'),max:dom.bossTrack.getAttribute('aria-valuemax'),text:dom.bossTrack.getAttribute('aria-valuetext')};
      $state.dashSequence+=1;
      damageEnemy(boss);
      const after={now:dom.bossTrack.getAttribute('aria-valuenow'),max:dom.bossTrack.getAttribute('aria-valuemax'),text:dom.bossTrack.getAttribute('aria-valuetext')};
      return {before,after,hp:boss.hp};
    `);
    assert.deepEqual(bossAria.before, { now: '100', max: '100', text: '深潮主脑稳定度 6 / 6' });
    assert.equal(bossAria.hp, 25);
    assert.deepEqual(bossAria.after, { now: '83', max: '100', text: '深潮主脑稳定度 5 / 6' });
  });
}

async function replayCleanupScenario() {
  await withPage('replay-cleanup', {}, async (page) => {
    page.requireDev('replay cleanup probe');
    await page.startGame();
    const reset = await page.gameEvaluate(`
      $state.combo=7;
      $state.comboTimer=9;
      dom.combo.classList.add('show');
      showStageBanner('STALE BANNER',99,'boss');
      toast('STALE TOAST','danger');
      $state.dashCharges=[1,1];
      $state.dashTimer=0;
      attemptDash(new THREE.Vector2(0,1));
      resetState();
      return {
        combo:$state.combo,comboTimer:$state.comboTimer,comboShow:dom.combo.classList.contains('show'),
        toastTimer:$state.toastTimer,toastShow:dom.toast.classList.contains('show'),toastText:dom.toast.textContent,
        bannerTimer:$state.stageBannerTimer,bannerShow:dom.stageBanner.classList.contains('show'),bannerText:dom.stageBannerTitle.textContent,bannerTone:dom.stageBanner.dataset.tone ?? null,
        enemies:$enemies.length,shards:shards.length,particles:particles.length,ripples:ripples.length,trails:trails.length,floating:floatingTexts.length,
        score:$state.score,bossDeadline:$state.bossDeadline,bossSpawned:$state.bossSpawned,maxHealth:$state.maxHealth,health:$state.health,
      };
    `);
    assert.deepEqual(reset, {
      combo: 0,
      comboTimer: 0,
      comboShow: false,
      toastTimer: 0,
      toastShow: false,
      toastText: '',
      bannerTimer: 0,
      bannerShow: false,
      bannerText: '',
      bannerTone: null,
      enemies: 0,
      shards: 8,
      particles: 0,
      ripples: 0,
      trails: 0,
      floating: 0,
      score: 0,
      bossDeadline: null,
      bossSpawned: false,
      maxHealth: 3,
      health: 3,
    });

    await page.gameEvaluate(`finishRun('victory','bossDestroyed');return true`);
    await page.waitForPage(`document.querySelector('#overlay').classList.contains('visible')`);
    await page.click('#primary-button');
    await page.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    await sleep(100);
    const replay = await page.gameEvaluate(`return {
      mode:$state.mode,elapsed:$state.elapsed,score:$state.score,enemies:$enemies.length,shards:shards.length,
      comboShow:dom.combo.classList.contains('show'),bannerShow:dom.stageBanner.classList.contains('show'),bannerText:dom.stageBannerTitle.textContent,
      floating:floatingTexts.length,particles:particles.length,ripples:ripples.length,trails:trails.length,
      geometries:$renderer.info.memory.geometries,
    }`);
    assert.equal(replay.mode, 'playing');
    assert.equal(replay.score, 0);
    assert.equal(replay.enemies, 0);
    assert.equal(replay.shards, 8);
    assert.equal(replay.comboShow, false);
    assert.equal(replay.bannerShow, false);
    assert.equal(replay.bannerText, '');
    assert.equal(replay.floating, 0);
    assert.equal(replay.particles, 0);
    assert.equal(replay.ripples, 0);
    assert.equal(replay.trails, 0);

    const geometryCounts = [replay.geometries];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await page.gameEvaluate(`finishRun('gameover','hullBreach');return true`);
      await page.waitForPage(`document.querySelector('#overlay').classList.contains('visible')`);
      await page.click('#primary-button');
      await page.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
      await sleep(100);
      geometryCounts.push(await page.gameEvaluate('return $renderer.info.memory.geometries'));
    }
    const postWarmup = geometryCounts.slice(1);
    assert.ok(Math.max(...postWarmup) - Math.min(...postWarmup) <= 1, `geometry count grows across replay: ${geometryCounts}`);
  });
}

async function jumpToBoss(page) {
  page.requireDev('boss terminal probe');
  // This only shortens the stage prelude. Boss attacks still progress through
  // the normal state machine in each scenario below.
  const bossState = await page.gameEvaluate(`
    clearWorldEntities();
    $state.upgradeTriggered=[true,true];
    $state.stageIndex=2;
    $state.stageQueue=[];
    $state.bossTriggered=false;
    $state.bossSpawned=false;
    $state.bossStart=null;
    $state.bossDeadline=null;
    $state.elapsed=100;
    $state.enemySpawnTimer=Infinity;
    updateStage();
    const boss=$enemies.find((enemy)=>enemy.type==='boss');
    return {stage:$state.stageIndex,deadline:$state.bossDeadline,timeLeft:$state.timeLeft,bossHp:boss?.hp,mode:$state.mode};
  `);
  await page.waitForPage(`!document.querySelector('#boss-panel').hidden`);
  return bossState;
}

async function victoryScenario() {
  await withPage('victory', {}, async (page) => {
    await page.startGame();
    const boss = await jumpToBoss(page);
    assert.equal(boss.stage, 3);
    assert.equal(boss.deadline, 126);
    assert.ok(boss.timeLeft > 25.5 && boss.timeLeft <= 26);
    assert.equal(boss.bossHp, 30);
    assert.equal(await page.evaluate(`document.querySelector('.time-card > span').textContent`), '首领窗口');
    assert.equal(await page.evaluate(`document.querySelector('#time-value').textContent`), '00:26');

    const settled = await page.gameEvaluate(`
      const boss=$enemies.find((enemy)=>enemy.type==='boss');
      boss.hp=5;
      $state.dashSequence+=1;
      damageEnemy(boss);
      return {mode:$state.mode,reason:$state.terminalReason,finished:$state.runFinished,score:$state.score};
    `);
    assert.equal(settled.mode, 'victory');
    assert.equal(settled.reason, 'bossDestroyed');
    assert.equal(settled.finished, true);
    await page.waitForPage(`document.querySelector('#overlay').classList.contains('visible')`);
    // A debugger pause can defer the modal's requestAnimationFrame focus callback.
    // Let that callback settle, then use the one-button trap as a deterministic
    // fallback before asserting the terminal focus contract.
    await sleep(100);
    if (await page.evaluate(`document.activeElement?.id !== 'primary-button'`)) {
      await page.pressKey('Tab', 'Tab');
    }
    assert.equal(await page.evaluate('document.activeElement?.id'), 'primary-button');
    await page.pressKey('Tab', 'Tab');
    assert.equal(await page.evaluate('document.activeElement?.id'), 'primary-button');
    const copy = await page.evaluate(`({kicker:document.querySelector('#overlay-kicker').textContent,copy:document.querySelector('#overlay-copy').textContent})`);
    assert.match(copy.kicker, /SIGNAL CLEAR/);
    assert.match(copy.copy, /深潮主脑已被摧毁/);
    const latch = await page.gameEvaluate(`const before=$state.score;const again=finishRun('victory','bossDestroyed');return {before,again,after:$state.score}`);
    assert.deepEqual(latch, { before: settled.score, again: false, after: settled.score });
  });
}

async function bossTimeoutScenario() {
  await withPage('boss-timeout', {}, async (page) => {
    await page.startGame();
    const boss = await jumpToBoss(page);
    assert.equal(boss.mode, 'playing');
    await page.gameEvaluate('$state.elapsed=$state.bossDeadline+0.01;return true');
    await page.waitForPage(`document.querySelector('#overlay-kicker').textContent.includes('WINDOW CLOSED')`);
    const terminal = await page.gameEvaluate('return {mode:$state.mode,reason:$state.terminalReason,finished:$state.runFinished}');
    assert.deepEqual(terminal, { mode: 'gameover', reason: 'bossDeadline', finished: true });
    const copy = await page.evaluate(`document.querySelector('#overlay-copy').textContent`);
    assert.match(copy, /终幕窗口已经关闭/);
    assert.doesNotMatch(copy, /船体已经失效/);
  });
}

async function bossPhaseTwoScenario() {
  await withPage('boss-phase-two', {}, async (page) => {
    await page.startGame();
    const timing = await page.gameEvaluate(`return {
      boundaries:[0,30,64,100].map((seconds)=>({seconds,stage:getStageIndex(seconds)})),
      duration:GAME.duration,bossStart:GAME.bossStart,bossWindow:GAME.bossWindow,
    }`);
    assert.deepEqual(timing.boundaries.map((entry) => entry.stage), [0,1,2,3]);
    assert.deepEqual({ duration:timing.duration,bossStart:timing.bossStart,bossWindow:timing.bossWindow }, { duration:126,bossStart:100,bossWindow:26 });
    const paused = await page.gameEvaluate(`const before=$state.elapsed;pauseGame();return {before,mode:$state.mode}`);
    await sleep(140);
    await page.click('#primary-button');
    await page.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    const pausedAfter = await page.gameEvaluate('return {elapsed:$state.elapsed,mode:$state.mode}');
    assert.equal(pausedAfter.mode, 'playing');
    assert.ok(Math.abs(pausedAfter.elapsed - paused.before) < 0.03, `pause advanced elapsed ${paused.before} -> ${pausedAfter.elapsed}`);
    const boss = await jumpToBoss(page);
    assert.equal(boss.deadline, 126);
    assert.ok(boss.timeLeft > 25.5 && boss.timeLeft <= 26);
    const phase = await page.gameEvaluate(`
      const boss=$enemies.find((enemy)=>enemy.type==='boss');
      const advance=(dt)=>{
        if($state.mode!=='playing') return;
        $state.elapsed+=dt;
        $state.dashTimer=Math.max(0,$state.dashTimer-dt);
        $state.dashInvulnTimer=Math.max(0,$state.dashInvulnTimer-dt);
        $state.hurtInvuln=Math.max(0,$state.hurtInvuln-dt);
        input.dashBuffer=Math.max(0,input.dashBuffer-dt);
        $state.dashCharges=$state.dashCharges.map((charge)=>Math.min(1,charge+dt/DASH_RECOVERY_TIME));
        updateStage();
        $state.timeLeft=Math.max(0,($state.bossDeadline ?? GAME.bossStart)-$state.elapsed);
        if($state.timeLeft<=0){finishRun('gameover','bossDeadline');return;}
        updatePlayer(dt);
        updateShards(dt);
        updateEnemies(dt);
      };
      const safePoint=new THREE.Vector2(7,-5);
      $player.position.copy(safePoint);
      const sawEnter=boss.state==='enter';
      for(let tick=0;tick<45;tick+=1) advance(0.05);
      const reachedFirstTelegraph=boss.state==='telegraph';
      // Four player dashes against the core cross the <50% threshold (30→10).
      let dashHits=0;
      for(let hit=0;hit<4 && $state.mode==='playing';hit+=1){
        while(!$state.dashCharges.some((charge)=>charge>=0.999) && $state.mode==='playing') advance(0.05);
        $player.position.copy(boss.group.position);
        $player.velocity.set(0,0);
        $player.facing.set(0,1);
        requestDash();
        advance(0.01);
        if(boss.lastDashId===$state.dashSequence) dashHits+=1;
        $player.position.copy(safePoint);
        $player.velocity.set(0,0);
        while($state.dashTimer>0 && $state.mode==='playing') advance(0.05);
      }
      for(let tick=0;tick<32 && boss.state!=='telegraph' && $state.mode==='playing';tick+=1) advance(0.05);
      return {
        phase:$state.stats.bossPhase,enemyPhase:boss.phase,sawEnter,reachedFirstTelegraph,
        phaseTwoTelegraph:boss.state==='telegraph' ? {kind:boss.attackKind,remaining:boss.telegraph} : null,
        attacks:[...$state.stats.bossAttackLog],hp:boss.hp,dashHits,
      };
    `);
    assert.equal(phase.phase, 2, 'boss phase 2 did not latch below 50%');
    assert.equal(phase.enemyPhase, 2, 'boss entity phase did not latch below 50%');
    assert.equal(phase.sawEnter, true, 'boss did not enter through its normal lifecycle');
    assert.equal(phase.reachedFirstTelegraph, true, 'boss did not reach phase 1 telegraph through authoritative ticks');
    assert.deepEqual(phase.phaseTwoTelegraph?.kind, 'sweepBeam', `phase 2 did not reach sweep telegraph: ${JSON.stringify(phase)}`);
    assert.ok(phase.phaseTwoTelegraph.remaining > 0 && phase.phaseTwoTelegraph.remaining <= 0.68);
    assert.equal(phase.hp, 10, 'phase transition did not use four dash damage steps');
    assert.equal(phase.dashHits, 4, `dash core contacts: ${phase.dashHits}`);
    assert.ok(phase.attacks.some((attack) => attack.kind === 'phase2-enter'), `phase 2 log missing: ${JSON.stringify(phase.attacks)}`);

    const pausedBoss = await page.gameEvaluate(`
      const boss=$enemies.find((enemy)=>enemy.type==='boss');
      pauseGame();
      return {mode:$state.mode,elapsed:$state.elapsed,state:boss.state,timer:boss.stateTimer,hazard:$state.stats.activeHazards};
    `);
    await sleep(140);
    await page.click('#primary-button');
    await page.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    const pausedBossAfter = await page.gameEvaluate(`
      const boss=$enemies.find((enemy)=>enemy.type==='boss');
      return {mode:$state.mode,elapsed:$state.elapsed,state:boss.state,timer:boss.stateTimer,hazard:$state.stats.activeHazards};
    `);
    assert.equal(pausedBossAfter.mode, 'playing');
    assert.equal(pausedBossAfter.state, pausedBoss.state, 'boss state changed while paused');
    assert.equal(pausedBossAfter.hazard, pausedBoss.hazard, 'boss hazard count changed while paused');
    assert.ok(Math.abs(pausedBossAfter.elapsed-pausedBoss.elapsed)<0.03, `boss pause advanced elapsed ${pausedBoss.elapsed} -> ${pausedBossAfter.elapsed}`);
    assert.ok(Math.abs(pausedBossAfter.timer-pausedBoss.timer)<0.03, `boss pause advanced timer ${pausedBoss.timer} -> ${pausedBossAfter.timer}`);

    const attacks = await page.gameEvaluate(`
      const boss=$enemies.find((enemy)=>enemy.type==='boss');
      $state.maxHealth=12;
      $state.health=12;
      const advance=(dt)=>{
        if($state.mode!=='playing') return;
        $state.elapsed+=dt;
        $state.dashTimer=Math.max(0,$state.dashTimer-dt);
        $state.dashInvulnTimer=Math.max(0,$state.dashInvulnTimer-dt);
        $state.hurtInvuln=Math.max(0,$state.hurtInvuln-dt);
        updateStage();
        $state.timeLeft=Math.max(0,($state.bossDeadline ?? GAME.bossStart)-$state.elapsed);
        if($state.timeLeft<=0){finishRun('gameover','bossDeadline');return;}
        updatePlayer(dt);
        updateShards(dt);
        updateEnemies(dt);
      };
      const seen=[]; let beamProbe=false; let triangleProbe=false; let flankPeak=0;
      for (let tick=0; tick<360 && $state.mode==='playing'; tick+=1) {
        if (seen.length>=3 && beamProbe && triangleProbe && flankPeak>=2) break;
        if (boss.state==='telegraph' && !seen.some((attack)=>attack.kind===boss.attackKind)) {
          seen.push({kind:boss.attackKind,telegraph:boss.telegraph,line:boss.visuals.line.visible,triangle:boss.visuals.trianglePulse.visible});
        }
        if (boss.state==='execute' && boss.attackKind==='sweepBeam' && !beamProbe) {
          $player.position.copy(boss.group.position).addScaledVector(boss.beamDirection,2.9);
          $state.hurtInvuln=0;
          const health=$state.health;
          advance(0.05);
          beamProbe=beamHitsPlayer(boss) && $state.health<health && $state.stats.activeHazards>0;
          continue;
        }
        if (boss.state==='execute' && boss.attackKind==='trianglePulse' && !triangleProbe && boss.dangerRadius>4.5) {
          const probeDistance=Math.min(5,boss.dangerRadius*0.65);
          const safe=boss.group.position.clone().addScaledVector(boss.triangleDirection,-probeDistance);
          $player.position.copy(safe); $state.hurtInvuln=0;
          const safeHealth=$state.health;
          advance(0.05);
          const safeHit=$state.health<safeHealth;
          $player.position.copy(boss.group.position).addScaledVector(boss.triangleDirection,probeDistance); $state.hurtInvuln=0;
          const dangerHealth=$state.health;
          advance(0.05);
          triangleProbe=!safeHit && $state.health<dangerHealth && boss.visuals.trianglePulse.visible && $state.stats.activeHazards>0;
          continue;
        }
        advance(0.1);
        flankPeak=Math.max(flankPeak,$enemies.filter((enemy)=>enemy.type==='swarm').length);
      }
      return {mode:$state.mode,seen,stats:[...$state.stats.bossAttackLog],telegraphs:[...$state.stats.bossAttackTelegraphs],beamProbe,triangleProbe,flankPeak,hazards:$state.stats.activeHazards};
    `);
    assert.equal(attacks.mode, 'playing', `phase 2 live hazard loop ended before victory probe: ${JSON.stringify(attacks)}`);
    assert.deepEqual(attacks.seen.map((attack) => attack.kind), ['sweepBeam', 'trianglePulse', 'flankSwarm']);
    assert.ok(attacks.telegraphs.length >= 3 && attacks.telegraphs.every((duration) => duration >= 0.68), `short boss telegraph: ${JSON.stringify(attacks.telegraphs)}`);
    assert.ok(attacks.seen.find((attack) => attack.kind === 'sweepBeam')?.line, 'sweep beam telegraph was not visible');
    assert.ok(attacks.seen.find((attack) => attack.kind === 'trianglePulse')?.triangle, 'triangle telegraph was not visible');
    assert.ok(attacks.beamProbe, 'sweep beam active collision did not register');
    assert.ok(attacks.triangleProbe, 'triangle pulse directional collision/hazard did not register');
    assert.ok(attacks.flankPeak >= 2, `flank swarm did not spawn: ${attacks.flankPeak}`);
    assert.ok(attacks.stats.some((attack) => attack.kind === 'sweepBeam' && attack.phase === 2));
    assert.ok(attacks.stats.some((attack) => attack.kind === 'trianglePulse' && attack.phase === 2));
    assert.ok(attacks.stats.some((attack) => attack.kind === 'flankSwarm' && attack.phase === 2));

    const victory = await page.gameEvaluate(`
      const before=finishRun('victory','bossDestroyed');
      return {accepted:before,mode:$state.mode,enemies:$enemies.length,hazards:$state.stats.activeHazards,reason:$state.terminalReason};
    `);
    assert.deepEqual(victory, { accepted:true, mode:'victory', enemies:0, hazards:0, reason:'bossDestroyed' });
    await page.waitForPage(`document.querySelector('#overlay').classList.contains('visible')`);
    await page.click('#primary-button');
    await page.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    await sleep(100);
    const restart = await page.gameEvaluate(`return {
      mode:$state.mode,bossPhase:$state.stats.bossPhase,bossAttackLog:$state.stats.bossAttackLog.length,
      bossAttackTelegraphs:$state.stats.bossAttackTelegraphs.length,enemies:$enemies.length,hazards:$state.stats.activeHazards,
      bossSpawned:$state.bossSpawned,bossTriggered:$state.bossTriggered,
    }`);
    assert.deepEqual(restart, {
      mode:'playing',bossPhase:1,bossAttackLog:0,bossAttackTelegraphs:0,enemies:0,hazards:0,
      bossSpawned:false,bossTriggered:false,
    });

    const restartedBoss = await jumpToBoss(page);
    assert.equal(restartedBoss.stage, 3);
    await page.gameEvaluate('$state.elapsed=$state.bossDeadline-0.05;return $state.elapsed', { stallMs: WALL_STALL_MS });
    await page.waitForPage(`document.querySelector('#overlay-kicker').textContent.includes('WINDOW CLOSED')`);
    const cleanup = await page.gameEvaluate('return {enemies:$enemies.length,hazards:$state.stats.activeHazards,mode:$state.mode}');
    assert.deepEqual(cleanup, { enemies: 0, hazards: 0, mode: 'gameover' });
  });
}

const scenarios = [
  ['briefing and laser UI', briefingAndLaserUiScenario],
  ['desktop load, wall clock, audio, repeat and focus', desktopCoreScenario],
  ['high-pressure combat director', highPressureCombatScenario],
  ['reviewed combat contracts', reviewedCombatContractsScenario],
  ['phone coarse layout 390x844', () => coarseLayoutScenario('phone-390x844', 390, 844, 2)],
  ['tablet coarse layout 1024x768', () => coarseLayoutScenario('tablet-1024x768', 1024, 768, 1)],
  ['reduced-motion warnings', reducedMotionScenario],
  ['desktop, coarse, and reduced-motion render quality', renderQualityScenario],
  ['four independent realm art directions', realmArtDirectionsScenario],
  ['runtime finite guards and listener lifecycle', runtimeGuardScenario],
  ['Repair Swarm and combat ARIA', repairAndAriaScenario],
  ['replay cleanup and geometry stability', replayCleanupScenario],
  ['boss victory', victoryScenario],
  ['boss timeout defeat', bossTimeoutScenario],
  ['boss phase two and attack cleanup', bossPhaseTwoScenario],
  ['natural light lance lifecycle', naturalLightLanceLifecycleScenario],
  ['light lance combat contracts', lightLanceCombatContractsScenario],
  ['pickup-charged light lance', chargedLightLanceScenario],
];

async function breakpointCleanupFailurePathSelfTest() {
  const calls = [];
  const client = {
    send(method) {
      calls.push(method);
      if (method === 'Debugger.setBreakpoint') return Promise.resolve({ breakpointId: 'bp-paused-timeout' });
      return Promise.resolve({});
    },
    waitFor(method) {
      calls.push(`wait:${method}`);
      let cancel;
      const promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${method} event timed out`)), 0);
        cancel = () => {
          clearTimeout(timeout);
          resolve(undefined);
        };
      });
      promise.cancel = () => cancel?.();
      return promise;
    },
  };
  const page = new GamePage('breakpoint-cleanup-self-test', {}, client, {});
  page.breakpointLocation = { scriptId: 'script-1', lineNumber: 10, columnNumber: 0 };
  await assert.rejects(
    page.scopeEvaluate('return true'),
    /scope evaluation 1 failed: Debugger\.paused event timed out/,
  );
  assert.deepEqual(calls, [
    'Page.bringToFront',
    'wait:Debugger.paused',
    'Debugger.setBreakpoint',
    'Debugger.removeBreakpoint',
    'Debugger.resume',
  ]);
}

if (process.env.BROWSER_MATRIX_BREAKPOINT_CLEANUP_SELF_TEST === '1') {
  try {
    await breakpointCleanupFailurePathSelfTest();
    console.log('ok 1 - paused-timeout breakpoint cleanup');
    console.log('1..1');
  } catch (error) {
    console.error('not ok 1 - paused-timeout breakpoint cleanup');
    console.error(error?.stack || error);
    console.log('1..1');
    process.exitCode = 1;
  }
} else {
  let passed = 0;
  try {
    const versionResponse = await fetch(`${CDP_HTTP}/json/version`);
    assert.ok(versionResponse.ok, `Chrome CDP is not available at ${CDP_HTTP}`);
    const version = await versionResponse.json();
    console.log(`# ${version.Browser}; app=${APP_URL}`);
    for (const [name, scenario] of scenarios) {
      const started = Date.now();
      await scenario();
      passed += 1;
      console.log(`ok ${passed} - ${name} (${Date.now() - started}ms)`);
    }
    console.log(`1..${scenarios.length}`);
  } catch (error) {
    console.error(`not ok ${passed + 1} - ${scenarios[passed]?.[0] || 'browser matrix setup'}`);
    console.error(error?.stack || error);
    console.log(`1..${scenarios.length}`);
    process.exitCode = 1;
  }
}
