/**
 * The first-run marker, and the one policy decision around it.
 *
 * `~/.kalo/onboarding.json` is the single source of truth: no reverse-inference
 * from "they already have an API key, so they must have seen the tour" — that
 * guess is wrong on a machine where Kalo was installed and never opened, and
 * being wrong there means the person who most needs the tour never gets it.
 *
 * A read failure counts as **completed**. The backend not being up (plain vite
 * dev, an unexpected IPC error) is not a reason to interrupt someone; a missing
 * tour costs a feature, a spurious one costs trust.
 */

import { readOnboardingState, writeOnboardingState } from "../../lib/pi-bridge";

/** Bumped when the tour changes enough that an old marker should not count. */
export const ONBOARDING_VERSION = 1;

/** True when the tour should be shown on this launch. */
export async function shouldShowOnboarding(): Promise<boolean> {
  try {
    const state = await readOnboardingState();
    return state.completed !== true;
  } catch {
    return false;
  }
}

/**
 * Mark the tour as done. Called by both "跳过" and the last step's finish
 * button — either way the user has decided, and neither should ask again.
 *
 * Failures are swallowed: the tour is already closing, and a toast about an
 * unwritable marker file helps nobody. The cost is one repeat on next launch.
 */
export async function markOnboardingDone(): Promise<void> {
  try {
    await writeOnboardingState({
      completed: true,
      completedAt: Date.now(),
      version: ONBOARDING_VERSION,
    });
  } catch {
    // See above.
  }
}
