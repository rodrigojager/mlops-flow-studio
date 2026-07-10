import { timingSafeEqual } from "node:crypto";

export interface ControlApiSecurityOptions {
  authToken?: string;
  allowInsecureNoAuth?: boolean;
  allowedOrigins?: string[];
}

export interface ControlApiSecurity {
  authToken: string | null;
  allowedOrigins: readonly string[];
  isOriginAllowed(origin: string): boolean;
  isAuthorized(authorizationHeader: string | undefined): boolean;
}

const LOOPBACK_ORIGIN = /^https?:\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d{1,5})?$/i;

export function createControlApiSecurity(options: ControlApiSecurityOptions): ControlApiSecurity {
  const allowInsecureNoAuth = options.allowInsecureNoAuth === true;
  const authToken = normalizeToken(options.authToken);
  if (!authToken && !allowInsecureNoAuth) {
    throw new Error(
      "Control API authentication is required. Set MLOPS_STUDIO_API_TOKEN or pass allowInsecureNoAuth only in isolated tests.",
    );
  }

  const allowedOrigins = normalizeOrigins(options.allowedOrigins);
  return {
    authToken,
    allowedOrigins,
    isOriginAllowed(origin) {
      if (allowedOrigins.length > 0) {
        return allowedOrigins.includes(origin);
      }
      return origin === "null" || LOOPBACK_ORIGIN.test(origin);
    },
    isAuthorized(authorizationHeader) {
      if (!authToken) {
        return true;
      }
      if (!authorizationHeader?.startsWith("Bearer ")) {
        return false;
      }
      const suppliedToken = authorizationHeader.slice("Bearer ".length).trim();
      return constantTimeEqual(suppliedToken, authToken);
    },
  };
}

export function parseAllowedOrigins(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : undefined;
}

function normalizeToken(value: string | undefined): string | null {
  const token = value?.trim();
  if (!token) {
    return null;
  }
  if (token.length < 24) {
    throw new Error("MLOPS_STUDIO_API_TOKEN must contain at least 24 characters.");
  }
  return token;
}

function normalizeOrigins(origins: string[] | undefined): string[] {
  return [...new Set((origins ?? []).map((origin) => origin.trim()).filter(Boolean))];
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
