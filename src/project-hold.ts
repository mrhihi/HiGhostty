// Manual hold: while a person is at an agent's terminal the project must not type into it. Pure
// state over a map; main.ts feeds it "the user looked at / left this terminal" and the pump asks it.
export type Hold = { leftAt?: number; idleSince?: number };
export type Holds = Map<string, Hold>;

// How long the terminal must stay idle after the user leaves before the project takes it back.
export const RELEASE_QUIET_MS = 10_000;

export const holdInstance = (holds: Holds, instance: string) => { holds.set(instance, {}); };
// The user moved away; the countdown to release starts, but only idle time counts.
export function leaveInstance(holds: Holds, instance: string, now: number) {
  const hold = holds.get(instance);
  if (hold && hold.leftAt === undefined) holds.set(instance, { leftAt: now });
}
// "Give it back": the user says they are done.
export const giveBack = (holds: Holds, instance: string) => holds.delete(instance);
export const isHeld = (holds: Holds, instance: string) => holds.has(instance);

// Advance one instance. `observed` is what its screen shows now. Returns true when the hold ended.
export function tickHold(holds: Holds, instance: string, observed: "working" | "idle" | "blocked" | "unknown" | undefined, now: number): boolean {
  const hold = holds.get(instance);
  if (!hold || hold.leftAt === undefined) return false;
  if (observed !== "idle") {
    holds.set(instance, { leftAt: hold.leftAt });
    return false;
  }
  const idleSince = hold.idleSince ?? now;
  if (now - idleSince >= RELEASE_QUIET_MS) {
    holds.delete(instance);
    return true;
  }
  holds.set(instance, { leftAt: hold.leftAt, idleSince });
  return false;
}
