import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173/';
export const CDP_PORT = Number(process.env.CDP_PORT || 9333);
export const WALL_STALL_MS = Number(process.env.WALL_STALL_MS || 1200);
export const PAUSE_ONLY_STALL_MS = WALL_STALL_MS + 120;
export const POST_RESUME_STALL_MS = Number(process.env.POST_RESUME_STALL_MS || 140);
export const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;
export const REALM_SCREENSHOT_DIR = process.env.REALM_SCREENSHOT_DIR || '';
export const REALM_SCREENSHOT_ONLY = process.env.REALM_SCREENSHOT_ONLY === '1';
export const BROWSER_MATRIX_SCENARIO = process.env.BROWSER_MATRIX_SCENARIO || '';

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class CDPClient {
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
  if (key === 'Enter') return { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  if (key === ' ') return { windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  if (/^[0-9]$/.test(key)) {
    const value = key.charCodeAt(0);
    return { windowsVirtualKeyCode: value, nativeVirtualKeyCode: value };
  }
  const value = key.toUpperCase().charCodeAt(0);
  return { windowsVirtualKeyCode: value, nativeVirtualKeyCode: value, code };
}

export class GamePage {
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
      forcedColors: false,
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
      features: [
        {
          name: 'prefers-reduced-motion',
          value: this.options.reducedMotion ? 'reduce' : 'no-preference',
        },
        {
          name: 'forced-colors',
          value: this.options.forcedColors ? 'active' : 'none',
        },
      ],
    });

    // Browser scenarios share one Chrome profile. Keep v3 checkpoint state
    // scoped to each scenario's initial document while allowing a scenario to
    // verify its own reload/resume path below.
    const initialCheckpoint = this.options.initialCheckpoint ?? null;
    const checkpointCleanup = await this.client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: initialCheckpoint
        ? `try { localStorage.setItem('neon-tide:v3:checkpoint', ${JSON.stringify(JSON.stringify(initialCheckpoint))}); localStorage.setItem('neon-tide:v3:mode-preference','standard'); } catch {}`
        : `try { localStorage.removeItem('neon-tide:v3:checkpoint'); localStorage.removeItem('neon-tide:v3:mode-preference'); } catch {}`,
    });
    const loaded = this.client.waitFor('Page.loadEventFired');
    await this.client.send('Page.navigate', { url: this.options.appUrl ?? APP_URL });
    await loaded;
    await this.client.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: checkpointCleanup.identifier,
    });
    await this.waitForPage(`document.readyState === 'complete' && Boolean(document.querySelector('canvas'))`);
    await this.evaluate(`document.fonts?.ready?.then(()=>true) ?? true`);
    await this.waitForPage(`document.activeElement?.id === 'primary-button'`);
    await this.#discoverGameScript();
  }

  async #discoverGameScript() {
    let scriptInfo = null;
    let kind = null;
    for (const [url, info] of this.scripts) {
      if (/\/src\/app\/legacy-runtime\.js(?:\?|$)/.test(url)) {
        scriptInfo = info;
        kind = 'dev';
      } else if (!scriptInfo && /\/assets\/index-[^/]+\.js(?:\?|$)/.test(url)) {
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

    const probe = await this.evaluate(`globalThis.__NEON_TIDE_V3__?.getReleaseProbe?.()`);
    assert.deepEqual(probe, {
      apiVersion: 1,
      runtimeReady: true,
      frameScheduled: true,
      routeKind: this.options.expectedReleaseRouteKind ?? null,
      disposed: false,
    }, `${this.name}: stable production release probe is unavailable`);
    this.breakpointLocation = null;
    this.names = {};
  }

  requireDev(feature) {
    assert.equal(this.scriptKind, 'dev', `${this.name}: ${feature} requires the Vite dev source (APP_URL=${this.options.appUrl ?? APP_URL})`);
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
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        lastValue = await this.evaluate(`Boolean(${expression})`);
        if (lastValue) return true;
        lastError = null;
      } catch (error) {
        lastError = error?.message || String(error);
        // The execution context can briefly disappear during Vite reloads.
      }
      await sleep(25);
    }
    throw new Error(`${this.name}: page condition timed out: ${expression} (last=${lastValue}; error=${lastError})`);
  }

  async scopeEvaluate(expression, { stallMs = 0 } = {}) {
    assert.ok(this.breakpointLocation, `${this.name}: lexical runtime scope evaluation requires the Vite dev source`);
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

  async gameEvaluateAcrossFrames(setupBody, snapshotBody, frameCount = 2) {
    this.requireDev('exact production-frame evaluation');
    this.scopeEvaluationCount += 1;
    const evaluationNumber = this.scopeEvaluationCount;
    const aliases = [
      `const $state=${this.names.state}`,
      `const $enemies=${this.names.enemies}`,
      `const $audio=${this.names.audio}`,
      `const $player=${this.names.player}`,
      `const $renderer=${this.names.renderer}`,
    ];
    const wrap = (body) => `(()=>{${aliases.join(';')};${body}})()`;
    const evaluateFrame = async (paused, expression) => {
      const frame = paused.callFrames.find((candidate) => candidate.functionName === 'animate') || paused.callFrames[0];
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
    };

    await this.client.send('Page.bringToFront');
    let pauseWait = this.client.waitFor('Debugger.paused');
    pauseWait.catch(() => {});
    let breakpointId;
    try {
      const breakpoint = await this.client.send('Debugger.setBreakpoint', { location: this.breakpointLocation });
      ({ breakpointId } = breakpoint);
      let paused = await pauseWait;
      const initial = await evaluateFrame(paused, wrap(setupBody));
      const frames = [];
      for (let index = 0; index < frameCount; index += 1) {
        pauseWait = this.client.waitFor('Debugger.paused');
        pauseWait.catch(() => {});
        await this.client.send('Debugger.resume');
        paused = await pauseWait;
        frames.push(await evaluateFrame(paused, wrap(snapshotBody)));
      }
      return { initial, frames };
    } catch (error) {
      pauseWait.cancel();
      throw new Error(`${this.name}: across-frame evaluation ${evaluationNumber} failed: ${error.message}`, { cause: error });
    } finally {
      if (breakpointId) await this.client.send('Debugger.removeBreakpoint', { breakpointId }, 3000).catch(() => {});
      await this.client.send('Debugger.resume', {}, 3000).catch(() => {});
    }
  }

  async waitForGame(body, predicate, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    let snapshot;
    while (Date.now() < deadline) {
      snapshot = await this.gameEvaluate(body);
      if (predicate(snapshot)) return snapshot;
      await sleep(25);
    }
    throw new Error(`${this.name}: game condition timed out (last=${JSON.stringify(snapshot)})`);
  }

  async click(selector) {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, { idempotent: false });
  }

  async trustedClick(selector) {
    const point = await this.evaluate(`(()=>{
      const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    })()`);
    await this.client.send('Input.dispatchMouseEvent', { type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1 });
    await this.client.send('Input.dispatchMouseEvent', { type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1 });
  }

  async tap(selector) {
    const selectorLiteral = JSON.stringify(selector);
    const requiresHitTarget = await this.evaluate(`(()=>{
      const element=document.querySelector(${selectorLiteral});
      const style=element&&getComputedStyle(element);
      const rect=element?.getBoundingClientRect();
      return Boolean(style?.display!=='none'&&style?.visibility!=='hidden'&&rect?.width&&rect?.height);
    })()`);
    if (requiresHitTarget) {
      await this.waitForPage(`(()=>{
        const element=document.querySelector(${selectorLiteral});
        const rect=element.getBoundingClientRect();
        const target=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
        return target===element||element.contains(target);
      })()`);
    }
    const point = await this.evaluate(`(()=>{
      const rect=document.querySelector(${selectorLiteral}).getBoundingClientRect();
      return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    })()`);
    await this.client.send('Page.bringToFront');
    await this.client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: point.x, y: point.y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
    });
    // Let Chrome's input pipeline observe the contact before ending it. This prevents
    // a transition-covered control from intermittently losing its synthesized click.
    await sleep(32);
    await this.client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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
    await this.client.send('Page.bringToFront');
    await this.dispatchKey('rawKeyDown', key, code, extra);
    await this.dispatchKey('keyUp', key, code, { modifiers: extra.modifiers || 0 });
  }

  async pressNativeKey(key, code) {
    await this.client.send('Page.bringToFront');
    const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
    await this.dispatchKey('keyDown', key, code, text ? { text, unmodifiedText:text } : {});
    await this.dispatchKey('keyUp', key, code);
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
    await this.client.send('Page.bringToFront');
    await this.trustedClick('#primary-button');
    await this.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    await this.waitForPage(`document.activeElement?.tagName === 'CANVAS'`, 3000);
    assert.equal(await this.evaluate(`document.activeElement?.tagName`), 'CANVAS', `${this.name}: gameplay focus did not move to the canvas`);
    assert.equal(await this.evaluate(`document.activeElement?.matches('button')`), false, `${this.name}: gameplay focus remains on a button`);
  }

  async reload() {
    const loaded = this.client.waitFor('Page.loadEventFired');
    await this.client.send('Page.reload', { ignoreCache: true });
    await loaded;
    await this.waitForPage(`document.readyState === 'complete' && Boolean(document.querySelector('canvas'))`);
    await this.evaluate(`document.fonts?.ready?.then(()=>true) ?? true`);
    await this.waitForPage(`document.activeElement?.id === 'primary-button'`);
    await this.#discoverGameScript();
    return true;
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

export async function withPage(name, options, callback) {
  const page = await GamePage.open(name, options);
  try {
    await callback(page);
    await page.assertClean();
  } finally {
    await page.close();
  }
}

export async function captureNaturalRealmScreenshots() {
  assert.ok(REALM_SCREENSHOT_DIR, 'REALM_SCREENSHOT_DIR is required for release screenshots');
  const captures = [
    { elapsed:12, stage:0, file:'v2.2-abyss.png' },
    { elapsed:44, stage:1, file:'v2.2-data-city.png' },
    { elapsed:78, stage:2, file:'v2.2-star-forge.png' },
    { elapsed:108, stage:3, file:'v2.2-void-cathedral.png' },
  ];

  await withPage('release-realm-screenshots', {}, async (page) => {
    page.requireDev('natural release screenshot automation');
    await page.startGame();
    await page.gameEvaluate(`
      const captureAutomation={
        timer:null,
        snapshot:()=>({
          elapsed:$state.elapsed,stage:$state.stageIndex,mode:$state.mode,health:$state.health,
          enemies:$enemies.filter((enemy)=>!enemy.dead).length,
          projectiles:projectiles.filter((projectile)=>projectile.active).length,
          hazards:$state.stats.activeHazards,
          environment:{type:environmentFrame.type,phase:environmentFrame.phase,visuals:Object.values(environmentVisual).filter((visual)=>visual.group.visible).length},
          player:[Number($player.position.x.toFixed(2)),Number($player.position.y.toFixed(2))],
          realm:document.documentElement.dataset.realm,
        }),
        stop:()=>{window.clearInterval(captureAutomation.timer);input.keys.clear();},
      };
      captureAutomation.timer=window.setInterval(()=>{
        $state.health=$state.maxHealth;
        $state.hurtInvuln=Math.max($state.hurtInvuln,0.45);
        if($state.mode!=='playing') return;
        const waypoints=[[-3,2],[3,2],[3,-2],[-3,-2]];
        const target=waypoints[Math.floor($state.elapsed/6)%waypoints.length];
        input.keys.clear();
        if($player.position.x<target[0]-0.35) input.keys.add('d');
        if($player.position.x>target[0]+0.35) input.keys.add('a');
        if($player.position.y<target[1]-0.35) input.keys.add('w');
        if($player.position.y>target[1]+0.35) input.keys.add('s');
      },100);
      Object.defineProperty(globalThis,'__NEON_TIDE_RELEASE_CAPTURE__',{configurable:true,value:captureAutomation});
      return captureAutomation.snapshot();
    `);

    const deadline = Date.now() + 140000;
    for (const capture of captures) {
      let snapshot;
      while (Date.now() < deadline) {
        const upgradeOpen = await page.evaluate(`!document.querySelector('#upgrade-panel').hidden`);
        if (upgradeOpen) {
          await page.click('.upgrade-option');
          await page.waitForPage(`document.querySelector('#upgrade-panel').hidden`);
          await page.waitForPage(`document.activeElement?.tagName === 'CANVAS'`);
        }
        snapshot = await page.evaluate(`globalThis.__NEON_TIDE_RELEASE_CAPTURE__.snapshot()`);
        assert.ok(!['gameover','victory'].includes(snapshot.mode), `release capture ended early: ${JSON.stringify(snapshot)}`);
        if (snapshot.elapsed >= capture.elapsed) break;
        await sleep(40);
      }
      assert.ok(snapshot && snapshot.elapsed >= capture.elapsed && snapshot.elapsed < capture.elapsed + 0.8,
        `release capture missed ${capture.elapsed}s: ${JSON.stringify(snapshot)}`);
      assert.equal(snapshot.stage, capture.stage, `release capture realm mismatch: ${JSON.stringify(snapshot)}`);
      assert.equal(snapshot.mode, 'playing', `release capture was not live combat: ${JSON.stringify(snapshot)}`);
      assert.ok(snapshot.enemies > 0, `release capture had no active enemies: ${JSON.stringify(snapshot)}`);
      const filePath = path.join(REALM_SCREENSHOT_DIR, capture.file);
      await page.captureScreenshot(filePath);
      console.log(`# screenshot ${filePath} elapsed=${snapshot.elapsed.toFixed(3)} stage=${snapshot.stage} enemies=${snapshot.enemies} projectiles=${snapshot.projectiles} environment=${snapshot.environment.type}/${snapshot.environment.phase}`);
    }

    await page.evaluate(`globalThis.__NEON_TIDE_RELEASE_CAPTURE__.stop();delete globalThis.__NEON_TIDE_RELEASE_CAPTURE__`);
  });
}


export async function breakpointCleanupFailurePathSelfTest() {
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
