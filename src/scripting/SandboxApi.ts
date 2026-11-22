/**
 * The scripting API exposed to user scripts (`pm.*`).
 *
 * This module builds a plain object graph that is evaluated inside an isolated `vm` context in a
 * worker thread. It must not reference Node APIs, `require`, or the extension host: everything it
 * needs is passed in through {@link ScriptEnvironment}.
 */

export interface ScriptRequestSnapshot {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ScriptResponseSnapshot {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  responseTime: number;
  sizeBytes: number;
  contentType: string;
}

export interface ScriptConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

export interface ScriptRuntime {
  tests: { name: string; passed: boolean; error?: string; stack?: string; durationMs: number }[];
  console: ScriptConsoleEntry[];
  /** Variables set by the script. Secret values are merged host-side. */
  variables: Record<string, string>;
  environment: Record<string, string>;
  request: ScriptRequestSnapshot;
}

export interface ScriptEnvironment {
  request: ScriptRequestSnapshot;
  response?: ScriptResponseSnapshot;
  variables: Record<string, string>;
  environment: Record<string, string>;
  phase: 'pre-request' | 'tests';
}

class ExpectationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

/* ------------------------------------------------------------------------------------------------
 * Request / response wrappers
 * ---------------------------------------------------------------------------------------------- */

function headerStore(headers: Record<string, string>) {
  return {
    get(name: string): string | undefined {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === String(name).toLowerCase());
      return key === undefined ? undefined : headers[key];
    },
    has(name: string): boolean {
      return Object.keys(headers).some((k) => k.toLowerCase() === String(name).toLowerCase());
    },
    all(): { key: string; value: string }[] {
      return Object.entries(headers).map(([key, value]) => ({ key, value }));
    },
    toObject(): Record<string, string> {
      return { ...headers };
    }
  };
}

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Assertion library (chai-compatible subset used by Postman scripts)
 * ---------------------------------------------------------------------------------------------- */

interface AssertionState {
  negate: boolean;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a === null || b === null || typeof a !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) {
    return false;
  }
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(objB, key) && deepEqual(objA[key], objB[key]));
}

function inspect(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Creates a chai-like assertion object. Supports the most common Postman assertion patterns; the
 * supported subset is documented in docs/scripting.md.
 */
export function createExpect(actual: unknown, state: AssertionState = { negate: false }): unknown {
  const check = (condition: boolean, message: string, negatedMessage: string) => {
    const ok = state.negate ? !condition : condition;
    if (!ok) {
      throw new ExpectationFailure(state.negate ? negatedMessage : message);
    }
  };

  const chain = (negate: boolean) => createExpect(actual, { negate: state.negate ? !negate : negate });


  const assertions: Record<string, unknown> = {
    get not() {
      return chain(true);
    },
    get to() {
      return assertions;
    },
    get be() {
      return assertions;
    },
    get been() {
      return assertions;
    },
    get is() {
      return assertions;
    },
    get that() {
      return assertions;
    },
    get which() {
      return assertions;
    },
    get and() {
      return assertions;
    },
    get has() {
      return assertions;
    },
    get have() {
      return assertions;
    },
    get with() {
      return assertions;
    },
    get at() {
      return assertions;
    },
    get of() {
      return assertions;
    },
    get same() {
      return assertions;
    },
    get deep() {
      return assertions;
    },
    get a() {
      return callableType;
    },
    get an() {
      return callableType;
    },
    /**
     * Chai allows both `expect(x).to.be.a('string')` (a type assertion) and the property form
     * `expect(x).to.be.an.array`. A getter cannot be called, so a callable proxy backed by the
     * same assertion object serves both spellings.
     */
    get type() {
      return callableType;
    },

    get ok() {
      check(Boolean(actual), `expected ${inspect(actual)} to be truthy`, `expected ${inspect(actual)} to be falsy`);
      return assertions;
    },
    get true() {
      check(actual === true, `expected ${inspect(actual)} to be true`, `expected ${inspect(actual)} not to be true`);
      return assertions;
    },
    get false() {
      check(actual === false, `expected ${inspect(actual)} to be false`, `expected ${inspect(actual)} not to be false`);
      return assertions;
    },
    get null() {
      check(actual === null, `expected ${inspect(actual)} to be null`, `expected ${inspect(actual)} not to be null`);
      return assertions;
    },
    get undefined() {
      check(actual === undefined, `expected ${inspect(actual)} to be undefined`, `expected ${inspect(actual)} not to be undefined`);
      return assertions;
    },
    get exist() {
      check(actual !== null && actual !== undefined, `expected ${inspect(actual)} to exist`, `expected ${inspect(actual)} not to exist`);
      return assertions;
    },
    get empty() {
      const empty =
        actual === '' ||
        (Array.isArray(actual) && actual.length === 0) ||
        (typeof actual === 'object' && actual !== null && Object.keys(actual).length === 0);
      check(empty, `expected ${inspect(actual)} to be empty`, `expected ${inspect(actual)} not to be empty`);
      return assertions;
    },

    equal(expected: unknown) {
      check(actual === expected, `expected ${inspect(actual)} to equal ${inspect(expected)}`, `expected ${inspect(actual)} not to equal ${inspect(expected)}`);
      return assertions;
    },
    equals(expected: unknown) {
      return (assertions.equal as (v: unknown) => unknown)(expected);
    },
    eq(expected: unknown) {
      return (assertions.equal as (v: unknown) => unknown)(expected);
    },
    eql(expected: unknown) {
      check(deepEqual(actual, expected), `expected ${inspect(actual)} to deeply equal ${inspect(expected)}`, `expected ${inspect(actual)} not to deeply equal ${inspect(expected)}`);
      return assertions;
    },
    above(n: number) {
      check(Number(actual) > n, `expected ${inspect(actual)} to be above ${n}`, `expected ${inspect(actual)} to be at most ${n}`);
      return assertions;
    },
    greaterThan(n: number) {
      return (assertions.above as (v: number) => unknown)(n);
    },
    below(n: number) {
      check(Number(actual) < n, `expected ${inspect(actual)} to be below ${n}`, `expected ${inspect(actual)} to be at least ${n}`);
      return assertions;
    },
    lessThan(n: number) {
      return (assertions.below as (v: number) => unknown)(n);
    },
    least(n: number) {
      check(Number(actual) >= n, `expected ${inspect(actual)} to be at least ${n}`, `expected ${inspect(actual)} to be below ${n}`);
      return assertions;
    },
    most(n: number) {
      check(Number(actual) <= n, `expected ${inspect(actual)} to be at most ${n}`, `expected ${inspect(actual)} to be above ${n}`);
      return assertions;
    },
    within(min: number, max: number) {
      check(Number(actual) >= min && Number(actual) <= max, `expected ${inspect(actual)} to be within ${min}..${max}`, `expected ${inspect(actual)} not to be within ${min}..${max}`);
      return assertions;
    },
    include(expected: unknown) {
      let condition = false;
      if (typeof actual === 'string') {
        condition = actual.includes(String(expected));
      } else if (Array.isArray(actual)) {
        condition = actual.some((item) => deepEqual(item, expected));
      } else if (actual && typeof actual === 'object') {
        condition = Object.prototype.hasOwnProperty.call(actual, String(expected));
      }
      check(condition, `expected ${inspect(actual)} to include ${inspect(expected)}`, `expected ${inspect(actual)} not to include ${inspect(expected)}`);
      return assertions;
    },
    contains(expected: unknown) {
      return (assertions.include as (v: unknown) => unknown)(expected);
    },
    property(name: string, value?: unknown) {
      const has = actual !== null && actual !== undefined && typeof actual === 'object' && Object.prototype.hasOwnProperty.call(actual, name);
      check(has, `expected ${inspect(actual)} to have property ${inspect(name)}`, `expected ${inspect(actual)} not to have property ${inspect(name)}`);
      if (value !== undefined && has) {
        const actualValue = (actual as Record<string, unknown>)[name];
        check(deepEqual(actualValue, value), `expected property ${inspect(name)} to equal ${inspect(value)} but got ${inspect(actualValue)}`, `expected property ${inspect(name)} not to equal ${inspect(value)}`);
      }
      return assertions;
    },
    keys(...keys: string[]) {
      const flat = keys.flat();
      const actualKeys = actual && typeof actual === 'object' ? Object.keys(actual) : [];
      const ok = flat.every((key) => actualKeys.includes(key));
      check(ok, `expected ${inspect(actual)} to have keys ${inspect(flat)}`, `expected ${inspect(actual)} not to have keys ${inspect(flat)}`);
      return assertions;
    },
    lengthOf(n: number) {
      const length = (actual as { length?: number })?.length;
      check(length === n, `expected ${inspect(actual)} to have length ${n}`, `expected ${inspect(actual)} not to have length ${n}`);
      return assertions;
    },
    match(pattern: RegExp) {
      const ok = pattern instanceof RegExp ? pattern.test(String(actual)) : new RegExp(String(pattern)).test(String(actual));
      check(ok, `expected ${inspect(actual)} to match ${String(pattern)}`, `expected ${inspect(actual)} not to match ${String(pattern)}`);
      return assertions;
    },
    oneOf(values: unknown[]) {
      const ok = values.some((value) => deepEqual(value, actual));
      check(ok, `expected ${inspect(actual)} to be one of ${inspect(values)}`, `expected ${inspect(actual)} not to be one of ${inspect(values)}`);
      return assertions;
    },
    instanceof(constructor: unknown) {
      const ok = typeof constructor === 'function' && actual instanceof (constructor as new () => unknown);
      check(ok, `expected ${inspect(actual)} to be an instance of the given constructor`, `expected ${inspect(actual)} not to be an instance of the given constructor`);
      return assertions;
    }
  };

  // `assertions` is a plain object whose `not` getter closes over `assertions`. Copying it onto
  // `callable` with Object.assign would bind that getter to the new object and recurse forever, so
  // properties are redefined with the original getters/setters preserved and bound to `callable`.
  const callable = ((..._args: unknown[]) => callable) as unknown as Record<string, unknown>;
  Object.defineProperties(
    callable,
    Object.getOwnPropertyDescriptors(assertions) as PropertyDescriptorMap
  );
  function assertType(expected: string): Record<string, unknown> {
    const typeName = typeOf(actual);
    const normalised = String(expected).toLowerCase().replace(/^an? /, '');
    const matches = normalised === 'array' ? typeName === 'array' : typeName === normalised;
    check(matches, `expected ${inspect(actual)} to be a ${normalised}`, `expected ${inspect(actual)} not to be a ${normalised}`);
    return assertions;
  }

  // `Object.assign` would *invoke* the assertion getters (including `not`, which recurses), so the
  // callable wrapper is populated with property descriptors instead.
  const callableType = ((expected?: string) => (expected === undefined ? assertions : assertType(expected))) as unknown as Record<
    string,
    unknown
  >;
  Object.defineProperties(callableType, Object.getOwnPropertyDescriptors(assertions) as PropertyDescriptorMap);
  Object.defineProperties(callableType, {
    array: {
      get() {
        assertType('array');
        return assertions;
      }
    },
    object: {
      get() {
        assertType('object');
        return assertions;
      }
    },
    string: {
      get() {
        assertType('string');
        return assertions;
      }
    },
    number: {
      get() {
        assertType('number');
        return assertions;
      }
    },
    boolean: {
      get() {
        assertType('boolean');
        return assertions;
      }
    },
    function: {
      get() {
        assertType('function');
        return assertions;
      }
    }
  });

  return callable;
}

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Builds the `pm` object for one script execution.
 * `reportTest` is invoked for every `pm.test(...)` call.
 */
export function createPm(env: ScriptEnvironment, runtime: ScriptRuntime) {
  const response = env.response;
  const responseHeaders = response ? headerStore(response.headers) : headerStore({});
  const requestHeaders = headerStore(env.request.headers);

  const assertionForStatus = (expected: number) => {
    if (!response) {
      throw new ExpectationFailure('No response is available in a pre-request script.');
    }
    if (response.status !== expected) {
      throw new ExpectationFailure(`expected response to have status code ${expected} but got ${response.status}`);
    }
  };

  const responseObject: Record<string, unknown> = {
    code: response?.status,
    status: response?.statusText,
    responseTime: response?.responseTime,
    responseSize: response?.sizeBytes,
    headers: responseHeaders,
    text(): string {
      return response?.body ?? '';
    },
    json(): unknown {
      const parsed = safeJsonParse(response?.body ?? '');
      if (!parsed.ok) {
        throw new ExpectationFailure(`The response body is not valid JSON: ${parsed.error}`);
      }
      return parsed.value;
    },
    reason(): string {
      return response?.statusText ?? '';
    }
  };

  const statusChain = {
    status(expected: number) {
      assertionForStatus(expected);
    },
    header(name: string, value?: string) {
      if (!response) {
        throw new ExpectationFailure('No response is available in a pre-request script.');
      }
      const actual = responseHeaders.get(name);
      if (actual === undefined) {
        throw new ExpectationFailure(`expected response to have header "${name}"`);
      }
      if (value !== undefined && actual !== value) {
        throw new ExpectationFailure(`expected header "${name}" to equal "${value}" but got "${actual}"`);
      }
    },
    json() {
      const parsed = safeJsonParse(response?.body ?? '');
      if (!parsed.ok) {
        throw new ExpectationFailure('expected response body to be JSON');
      }
    }
  };

  responseObject.to = {
    have: statusChain,
    be: {
      get json() {
        statusChain.json();
        return true;
      },
      ok(status: number) {
        if (status >= 200 && status < 300) {
          return true;
        }
        throw new ExpectationFailure(`expected status ${status} to be 2xx`);
      }
    }
  };

  const variableStore = (target: Record<string, string>) => ({
    get(name: string): string | undefined {
      return target[name];
    },
    set(name: string, value: unknown) {
      target[String(name)] = value === undefined || value === null ? '' : String(value);
    },
    unset(name: string) {
      delete target[name];
    },
    has(name: string): boolean {
      return Object.prototype.hasOwnProperty.call(target, name);
    },
    toObject(): Record<string, string> {
      return { ...target };
    },
    replaceIn(template: string): string {
      return String(template).replace(/\{\{\s*([A-Za-z0-9_.\-$]+)\s*\}\}/g, (match, name: string) =>
        Object.prototype.hasOwnProperty.call(target, name) ? target[name] : match
      );
    }
  });

  const pm = {
    response: responseObject,
    request: {
      method: env.request.method,
      url: {
        toString: () => env.request.url,
        get host() {
          return env.request.url;
        }
      },
      headers: requestHeaders,
      body: env.request.body
    },
    environment: variableStore(env.environment),
    variables: variableStore(runtime.variables),
    collectionVariables: variableStore({}),
    globals: variableStore({}),
    expect: (value: unknown) => createExpect(value),
    test(name: string, fn: () => void) {
      const started = Date.now();
      try {
        fn();
        runtime.tests.push({ name: String(name), passed: true, durationMs: Date.now() - started });
      } catch (error) {
        const err = error as Error;
        runtime.tests.push({
          name: String(name),
          passed: false,
          error: err?.message ?? String(error),
          stack: err?.stack,
          durationMs: Date.now() - started
        });
      }
    },
    info: {
      eventName: env.phase === 'pre-request' ? 'prerequest' : 'test',
      iteration: 0,
      requestName: ''
    },
    iteration: 0,
    vt: {
      typeOf
    }
  };

  return pm;
}
