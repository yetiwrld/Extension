import { AutomationError, ERROR_CODES } from './errors.js';

/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reject with a FLOW_NO_RESPONSE error if `promise` does not settle in time.
 * The underlying promise is not cancelled; it is simply ignored afterwards.
 */
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new AutomationError(ERROR_CODES.FLOW_NO_RESPONSE, message, { recoverable: true }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Serialise asynchronous jobs: each call to the returned function runs only
 * after the previously queued job has settled. Failures do not block the chain.
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(job) {
    const run = tail.then(() => job());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** Wall clock and timer implementation used in production code. */
export const systemClock = Object.freeze({
  now: () => Date.now(),
  sleep,
});
