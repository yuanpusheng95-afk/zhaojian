/** HTTP 层错误：状态码和错误码在构造时绑定，不再靠字符串表反查。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
