export class RapydError<T> extends Error {
  public code: T;
  public operationId: string;

  constructor(message: string, code: T, operationId: string) {
    super(message);
    this.code = code;
    this.operationId = operationId;
  }
}
