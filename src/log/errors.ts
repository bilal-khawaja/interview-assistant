export class NotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "NotFoundError";
  }
}

export class ProducerConflictError extends Error {
  constructor(
    readonly meetingId: string,
    readonly seq: number,
  ) {
    super(`seq ${seq} of meeting ${meetingId} already holds a different segment`);
    this.name = "ProducerConflictError";
  }
}

export class ProducerAlreadyActiveError extends Error {
  constructor(readonly meetingId: string) {
    super(`a producer is already active for meeting ${meetingId}`);
    this.name = "ProducerAlreadyActiveError";
  }
}

export class ProducerFailedError extends Error {
  constructor(cause: unknown) {
    super("producer failed; restart it to resume from the committed head", {
      cause,
    });
    this.name = "ProducerFailedError";
  }
}

export function isConstraintViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const state = (e as { errno?: unknown; code?: unknown }).errno;
    if (typeof state === "string" && state.startsWith("23")) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export class ProducerLockLostError extends Error {
  constructor(readonly meetingId: string) {
    super(
      `lost the producer lock for meeting ${meetingId} and could not get it back; another producer may have taken over`,
    );
    this.name = "ProducerLockLostError";
  }
}

export class ProducerLockUnverifiedError extends Error {
  constructor(readonly meetingId: string) {
    super(`producer lock for meeting ${meetingId} is not verified; waiting to reacquire it`);
    this.name = "ProducerLockUnverifiedError";
  }
}

export class MeetingGoneError extends Error {
  constructor(readonly meetingId: string) {
    super(`meeting ${meetingId} no longer exists`);
    this.name = "MeetingGoneError";
  }
}
