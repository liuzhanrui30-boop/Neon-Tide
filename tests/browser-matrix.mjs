import assert from 'node:assert/strict';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173/';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const WALL_STALL_MS = Number(process.env.WALL_STALL_MS || 1200);
const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;

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

  send(method, params = {}, timeoutMs = 15000) {
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

  waitFor(method, predicate = () => true, timeoutMs = 15000) {
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

  async evaluate(expression) {
    const result = await this.client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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
    let breakpointId;
    try {
      ({ breakpointId } = await this.client.send('Debugger.setBreakpoint', {
        location: this.breakpointLocation,
      }));
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
      if (breakpointId) await this.client.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
      await this.client.send('Debugger.resume').catch(() => {});
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
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
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

  async startGame() {
    await this.click('#primary-button');
    await this.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    await sleep(60);
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
    for (let repeat = 0; repeat < 3; repeat += 1) {
      await page.dispatchKey('rawKeyDown', 'p', 'KeyP', { autoRepeat: true });
    }
    assert.equal(await page.gameEvaluate('return $state.mode'), 'paused');
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

    await page.pressKey('p', 'KeyP');
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
    for (let repeat = 0; repeat < 8; repeat += 1) {
      await sleep(42);
      await page.dispatchKey('rawKeyDown', ' ', 'Space', { autoRepeat: true });
    }
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
      $state.elapsed=18;
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
    await page.dispatchKey('rawKeyDown', '1', 'Digit1', { autoRepeat: true });
    await page.dispatchKey('keyUp', '1', 'Digit1');
    assert.equal(await page.gameEvaluate('return $state.mode'), 'upgrade');
    assert.equal(await page.gameEvaluate('return $state.ownedUpgrades.length'), ownedBeforeRepeat);
    await page.pressKey('1', 'Digit1');
    await page.waitForPage(`document.querySelector('#upgrade-panel').hidden`);
    await page.waitForPage(`document.activeElement?.tagName === 'CANVAS'`);
  });
}

function layoutSnapshotExpression() {
  return `(()=>{
    const rect=(selector)=>{const e=document.querySelector(selector),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,display:s.display,visibility:s.visibility}};
    const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    const mission=rect('#mission-panel'),joystick=rect('#joystick'),dash=rect('#dash-button'),hud=rect('#hud'),touch=rect('#touch-controls');
    return {
      coarse:matchMedia('(pointer: coarse)').matches,
      touchPoints:navigator.maxTouchPoints,
      size:[innerWidth,innerHeight],
      overflow:[document.documentElement.scrollWidth-innerWidth,document.documentElement.scrollHeight-innerHeight],
      mission,joystick,dash,hud,touch,
      missionJoystickOverlap:overlap(mission,joystick),
      missionDashOverlap:overlap(mission,dash),
      objective:document.querySelector('#mission-objective').textContent.trim(),
      energyVisible:getComputedStyle(document.querySelector('.energy-track')).display!=='none',
      overdriveVisible:getComputedStyle(document.querySelector('#overdrive-label')).display!=='none',
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
    assert.ok(layout.objective.length > 0 && layout.energyVisible && layout.overdriveVisible, `${name}: compact mission status incomplete`);
    assert.equal(layout.missionJoystickOverlap, 0, `${name}: mission overlaps joystick by ${layout.missionJoystickOverlap}px²`);
    assert.equal(layout.missionDashOverlap, 0, `${name}: mission overlaps dash by ${layout.missionDashOverlap}px²`);
    for (const [elementName, rect] of [['mission', layout.mission], ['joystick', layout.joystick], ['dash', layout.dash]]) {
      assert.ok(rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= width + 0.5 && rect.bottom <= height + 0.5,
        `${name}: ${elementName} outside viewport ${JSON.stringify(rect)}`);
    }
    page.requireDev('coarse-pointer combat cap probe');
    const cap = await page.gameEvaluate(`
      clearWorldEntities();
      for (let index=0; index<50; index+=1) spawnEnemy('chaser');
      return {cap:getEnemyCap(),count:$enemies.length,peak:$state.stats.enemyPeak};
    `);
    assert.equal(cap.cap, 28, `${name}: coarse enemy cap changed`);
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
      $state.enemySpawnTimer=0;
      $state.formationTimer=0;
      for (let tick=0; tick<30; tick+=1) {
        $state.elapsed=tick;
        if (tick > 0 && tick % 6 === 0) $state.formationTimer=0;
        updateSpawning(0.1);
      }
      const firstThirty={formations:$state.stats.formationCount,peak:$state.stats.enemyPeak,roles:{...$state.stats.roles}};
      $state.stageIndex=1;
      $state.elapsed=42;
      $state.formationTimer=0;
      updateSpawning(0.1);
      const stageTwo={formations:$state.stats.formationCount,log:[...$state.stats.formationLog]};
      $state.stageIndex=2;
      $state.elapsed=80;
      $state.formationTimer=0;
      updateSpawning(0.1);
      const stageThree={formations:$state.stats.formationCount,log:[...$state.stats.formationLog]};
      const lancer=spawnEnemy('lancer',new THREE.Vector2(-4,0));
      for (let tick=0; tick<90; tick+=1) updateLancer(lancer,0.016,new THREE.Vector2(1,0));
      const lancerActive=lancer.state==='active' || lancer.visuals.beam.visible;
      const roles={...$state.stats.roles};
      const peak=$state.stats.enemyPeak;
      clearWorldEntities();
      return {firstThirty,stageTwo,stageThree,lancerActive,roles,peak,afterCleanup:$state.stats.activeCleanupCount,activeEnemies:$enemies.length};
    `);
    assert.ok(snapshot.firstThirty.peak >= 8, `enemy density too low in first 30s: ${snapshot.firstThirty.peak}`);
    assert.ok(snapshot.firstThirty.formations >= 2, `first 30s formations: ${snapshot.firstThirty.formations}`);
    assert.ok(Object.keys(snapshot.firstThirty.roles).length >= 3, `first 30s roles: ${JSON.stringify(snapshot.firstThirty.roles)}`);
    assert.ok(snapshot.stageTwo.formations >= snapshot.firstThirty.formations + 1, 'stage 2 formation did not fire');
    assert.ok(snapshot.stageThree.formations >= snapshot.stageTwo.formations + 1, 'stage 3 formation did not fire');
    assert.equal(snapshot.lancerActive, true, 'lancer beam telegraph/active lifecycle did not run');
    assert.ok(snapshot.roles.Lancer >= 1, `lancer role missing: ${JSON.stringify(snapshot.roles)}`);
    assert.ok(snapshot.afterCleanup > 0 && snapshot.activeEnemies === 0, 'combat cleanup left orphan enemies');
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
    assert.deepEqual(warnings.playerScale, [1, 1]);
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
  const bossState = await page.gameEvaluate(`
    clearWorldEntities();
    $state.upgradeTriggered=[true,true];
    $state.stageIndex=2;
    $state.stageQueue=[];
    $state.bossTriggered=false;
    $state.bossSpawned=false;
    $state.bossStart=null;
    $state.bossDeadline=null;
    $state.elapsed=53;
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
    assert.equal(boss.deadline, 71);
    assert.ok(boss.timeLeft > 17.5 && boss.timeLeft <= 18);
    assert.equal(boss.bossHp, 30);
    assert.equal(await page.evaluate(`document.querySelector('.time-card > span').textContent`), '首领窗口');
    assert.equal(await page.evaluate(`document.querySelector('#time-value').textContent`), '00:18');

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

const scenarios = [
  ['desktop load, wall clock, audio, repeat and focus', desktopCoreScenario],
  ['high-pressure combat director', highPressureCombatScenario],
  ['phone coarse layout 390x844', () => coarseLayoutScenario('phone-390x844', 390, 844, 2)],
  ['tablet coarse layout 1024x768', () => coarseLayoutScenario('tablet-1024x768', 1024, 768, 1)],
  ['reduced-motion warnings', reducedMotionScenario],
  ['Repair Swarm and combat ARIA', repairAndAriaScenario],
  ['replay cleanup and geometry stability', replayCleanupScenario],
  ['boss victory', victoryScenario],
  ['boss timeout defeat', bossTimeoutScenario],
];

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
