import { getConnectorRegistry } from "../registry/index.js";
import { GoogleCalendarConnector } from "./calendarConnector.js";

export { GoogleCalendarConnector, GoogleCalendarApiError } from "./calendarConnector.js";
export {
  GoogleOAuthClient,
  GoogleOAuthConfigError,
  GoogleOAuthApiError,
  loadGoogleOAuthConfig,
  GOOGLE_CALENDAR_READONLY_SCOPE,
} from "./oauthClient.js";
export type { GoogleOAuthConfig, TokenResponse, GoogleUserInfo } from "./oauthClient.js";

let registered = false;

/** Idempotent: registers GoogleCalendarConnector in the shared ConnectorRegistry. Safe to call more than once (e.g. once per test file). */
export function registerGoogleConnector(): void {
  if (registered) return;
  getConnectorRegistry().register(new GoogleCalendarConnector());
  registered = true;
}
