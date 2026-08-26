/**
 * Typing into the app's fields, in a window that does not own the keyboard.
 *
 * Measured 2026-08-24: a person typing at the machine while the parked test
 * window held keyboard focus left "làm" interleaved inside a board URL -
 * 'lhttp://127.0.0.1:51291àm' - and the step that followed failed for a reason
 * that looked exactly like a product bug. Every spec that types a value the
 * app then acts on goes through here, so a stray keystroke costs a retry
 * instead of a red test with a misleading diagnosis.
 */

/** A field that lost a race with the keyboard twice more is not losing a race. */
const ATTEMPTS = 3;

/**
 * Types a value into a field and proves it arrived whole.
 *
 * @param {WebdriverIO.Element} field an input or textarea
 * @param {string} value what it must hold when this resolves
 */
async function fill(field, value) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await field.setValue(value);
    if ((await field.getValue()) === value) return;
  }
  throw new Error(`a field never held "${value}" - something else is typing into this window`);
}

module.exports = { fill };
