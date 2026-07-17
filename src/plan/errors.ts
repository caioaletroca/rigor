/**
 * Errors thrown by the plan parser.
 */

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanParseError";
  }
}
