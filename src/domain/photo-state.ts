type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface ModifyInstruction {
  path: string;
  operation: "replace";
  value: unknown;
}

interface PreserveConstraint {
  path: string;
  strength: "soft" | "hard";
  source: "user";
}

interface StatePatch {
  modify: ModifyInstruction[];
  preserve: PreserveConstraint[];
}

type PhotoState = Record<string, unknown> & { constraints?: unknown[] };

const ALLOWED_MODIFY_PATHS = new Set([
  "subject.identity.preserve",
  "subject.hair.preserve",
  "subject.expression",
  "subject.pose",
  "scene.location",
  "scene.time",
  "scene.mood",
  "scene.background",
  "scene.lighting",
  "appearance.outfit",
  "appearance.makeup",
  "composition.shot",
  "composition.cameraAngle",
]);

const ALLOWED_PRESERVE_PATHS = new Set([
  "subject.identity",
  "subject.hair",
  "subject.expression",
  "subject.pose",
  "scene.background",
  "scene.location",
  "scene.lighting",
  "appearance.outfit",
  "appearance.makeup",
  "composition",
  "composition.shot",
  "composition.cameraAngle",
]);

const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const CONSTRAINT_STRENGTHS = new Set(["soft", "hard"]);

export class InvalidStatePatchError extends Error {
  code = "INVALID_STATE_PATCH";
  constructor(message: string) {
    super(message);
    this.name = "InvalidStatePatchError";
  }
}

export class PatchConflictError extends InvalidStatePatchError {
  path: string;
  constructor(path: string) {
    super(`State path cannot be modified and preserved together: ${path}`);
    this.name = "PatchConflictError";
    this.code = "PATCH_CONFLICT";
    this.path = path;
  }
}

export class UnsafeStatePathError extends InvalidStatePatchError {
  constructor(path?: string) {
    super(`Unsafe or unsupported state path: ${path}`);
    this.name = "UnsafeStatePathError";
    this.code = "UNSAFE_STATE_PATH";
  }
}

export function applyPhotoStatePatch(state: PhotoState, patch: StatePatch): PhotoState {
  validateState(state);
  const normalizedPatch = normalizePatch(patch);
  rejectConflicts(normalizedPatch);

  const next = structuredClone(state) as PhotoState;

  for (const instruction of normalizedPatch.modify) {
    setAtPath(next, instruction.path, structuredClone(instruction.value));
  }

  next.constraints = mergeConstraints(
    next.constraints as Record<string, unknown>[] | undefined,
    normalizedPatch.preserve,
  );

  return next;
}

function validateState(state: PhotoState): void {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new InvalidStatePatchError("Photo state must be an object");
  }

  if (state.constraints !== undefined && !Array.isArray(state.constraints)) {
    throw new InvalidStatePatchError("Photo state constraints must be an array");
  }
}

function normalizePatch(patch: Partial<StatePatch>): StatePatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new InvalidStatePatchError("State patch must be an object");
  }

  const modify = patch.modify ?? [];
  const preserve = patch.preserve ?? [];

  if (!Array.isArray(modify) || !Array.isArray(preserve)) {
    throw new InvalidStatePatchError("Modify and preserve must be arrays");
  }

  return {
    modify: modify.map(normalizeModifyInstruction),
    preserve: preserve.map(normalizePreserveConstraint),
  };
}

function normalizeModifyInstruction(instruction: Partial<ModifyInstruction>): ModifyInstruction {
  if (!instruction || typeof instruction !== "object") {
    throw new InvalidStatePatchError("Modify instruction must be an object");
  }

  const path = validatePath(instruction.path!, ALLOWED_MODIFY_PATHS);
  if (instruction.operation !== "replace") {
    throw new InvalidStatePatchError(
      `Unsupported modify operation: ${instruction.operation}`,
    );
  }

  if (!Object.hasOwn(instruction, "value")) {
    throw new InvalidStatePatchError(`Modify instruction is missing value: ${path}`);
  }

  return {
    path,
    operation: "replace",
    value: instruction.value,
  };
}

function normalizePreserveConstraint(constraint: Partial<PreserveConstraint>): PreserveConstraint {
  if (!constraint || typeof constraint !== "object") {
    throw new InvalidStatePatchError("Preserve constraint must be an object");
  }

  const path = validatePath(constraint.path!, ALLOWED_PRESERVE_PATHS);
  const strength = constraint.strength ?? "hard";
  if (!CONSTRAINT_STRENGTHS.has(strength)) {
    throw new InvalidStatePatchError(
      `Unsupported preserve strength: ${strength}`,
    );
  }

  return { path, strength: strength as "soft" | "hard", source: "user" };
}

function validatePath(path: string, allowedPaths: Set<string>): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new UnsafeStatePathError(path);
  }

  const segments = path.split(".");
  if (
    segments.some((segment) => !segment || UNSAFE_SEGMENTS.has(segment)) ||
    !allowedPaths.has(path)
  ) {
    throw new UnsafeStatePathError(path);
  }

  return path;
}

function rejectConflicts(patch: StatePatch): void {
  for (const modify of patch.modify) {
    const conflict = patch.preserve.find((preserve) =>
      pathsOverlap(modify.path, preserve.path),
    );
    if (conflict) {
      throw new PatchConflictError(conflict.path);
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}.`) ||
    right.startsWith(`${left}.`)
  );
}

function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let cursor: Record<string, unknown> = target;

  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (current === undefined) {
      cursor[segment] = {};
    } else if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new InvalidStatePatchError(
        `Cannot traverse non-object state path: ${path}`,
      );
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments.at(-1)!] = value;
}

function mergeConstraints(existing: Record<string, unknown>[] | undefined, incoming: PreserveConstraint[]): Record<string, unknown>[] {
  const byPath = new Map<string, Record<string, unknown>>();

  for (const constraint of existing ?? []) {
    if (constraint?.path) {
      byPath.set(constraint.path as string, structuredClone(constraint));
    }
  }

  for (const constraint of incoming as unknown as Record<string, unknown>[]) {
    byPath.set(constraint.path as string, constraint);
  }

  return [...byPath.values()];
}
