// Public frontend config for the Lamarck app shell.
//
// Everything here ships to the browser and is NOT secret. Clerk publishable
// keys are public by design (abuse is gated by Clerk allowed-origins, not key
// secrecy), so we select the instance by hostname instead of injecting at the
// edge: the production app domain uses the live instance; every other origin
// (workers.dev previews, localhost) uses the dev/test instance.
window.__LAMARCK_CONFIG__ = {
  clerkPublishableKey:
    location.hostname === "app.lamarck.ai"
      ? "pk_live_Y2xlcmsubGFtYXJjay5haSQ"
      : "pk_test_cGF0aWVudC1taW5ub3ctODYuY2xlcmsuYWNjb3VudHMuZGV2JA",
  apiBaseUrl:
    location.hostname === "app.lamarck.ai"
      ? "https://api.lamarck.ai"
      : "https://wqrkirptp9.execute-api.us-west-2.amazonaws.com",
};
