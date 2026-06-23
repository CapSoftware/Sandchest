export type PublicErrorCode =
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR"
  | "NOT_FOUND"
  | "NOT_IMPLEMENTED"
  | "VALIDATION_ERROR";

export type PublicApiError = {
  code: PublicErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type ApiSuccessResponse<TData> = {
  ok: true;
  data: TData;
};

export type ApiErrorResponse = {
  ok: false;
  error: PublicApiError;
};

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult<TValue> =
  | {
      ok: true;
      value: TValue;
    }
  | {
      ok: false;
      issues: ValidationIssue[];
    };

export function createApiSuccess<TData>(data: TData): ApiSuccessResponse<TData> {
  return {
    ok: true,
    data,
  };
}

export function createApiError(
  code: PublicErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorResponse {
  return {
    ok: false,
    error: details ? { code, details, message } : { code, message },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function readOptionalString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];

  if (!isNonEmptyString(value)) {
    return undefined;
  }

  return value;
}

export function readRequiredString(
  source: Record<string, unknown>,
  key: string,
): ValidationResult<string> {
  const value = readOptionalString(source, key);

  if (!value) {
    return {
      ok: false,
      issues: [
        {
          path: key,
          message: "Expected a non-empty string.",
        },
      ],
    };
  }

  return {
    ok: true,
    value,
  };
}
