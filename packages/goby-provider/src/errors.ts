// CHIP-0002 error codes — https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0002.md

export const ErrorCode = {
  InvalidParams: 4000,
  Unauthorized: 4001,
  UserRejected: 4002,
  SpendableBalanceExceeded: 4003,
  MethodNotFound: 4004,
  NoSecretKey: 4005,
  LimitExceeded: 4029,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class ChiaProviderError extends Error {
  readonly code: ErrorCodeValue;
  readonly data?: unknown;

  constructor(code: ErrorCodeValue, message: string, data?: unknown) {
    super(message);
    this.name = "ChiaProviderError";
    this.code = code;
    this.data = data;
  }

  toJSON() {
    return { code: this.code, message: this.message, data: this.data };
  }
}

export const Errors = {
  invalidParams: (msg = "Invalid params", data?: unknown) =>
    new ChiaProviderError(ErrorCode.InvalidParams, msg, data),
  unauthorized: (msg = "Unauthorized", data?: unknown) =>
    new ChiaProviderError(ErrorCode.Unauthorized, msg, data),
  userRejected: (msg = "User rejected the request", data?: unknown) =>
    new ChiaProviderError(ErrorCode.UserRejected, msg, data),
  spendableBalanceExceeded: (msg = "Spendable balance exceeded", data?: unknown) =>
    new ChiaProviderError(ErrorCode.SpendableBalanceExceeded, msg, data),
  methodNotFound: (method: string) =>
    new ChiaProviderError(ErrorCode.MethodNotFound, `Method not found: ${method}`),
  noSecretKey: (msg = "Wallet does not own a required secret key", data?: unknown) =>
    new ChiaProviderError(ErrorCode.NoSecretKey, msg, data),
  limitExceeded: (msg = "Rate limit exceeded", data?: unknown) =>
    new ChiaProviderError(ErrorCode.LimitExceeded, msg, data),
};
