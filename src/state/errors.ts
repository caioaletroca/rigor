/**
 * Domain errors for state management.
 */

export class InvalidTransitionError extends Error {
  readonly entityId: string;
  readonly from: string;
  readonly to: string;

  constructor(entityId: string, from: string, to: string) {
    super(
      `Invalid transition for "${entityId}": cannot move from "${from}" to "${to}"`,
    );
    this.name = "InvalidTransitionError";
    this.entityId = entityId;
    this.from = from;
    this.to = to;
  }
}

export class EntityNotFoundError extends Error {
  readonly entityType: string;
  readonly entityId: string;

  constructor(entityType: string, entityId: string) {
    super(`${entityType} "${entityId}" not found`);
    this.name = "EntityNotFoundError";
    this.entityType = entityType;
    this.entityId = entityId;
  }
}
