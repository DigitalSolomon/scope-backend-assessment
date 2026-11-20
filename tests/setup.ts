// Unit tests never touch the network or the database. These values only
// satisfy env validation and pin the configuration the tests assume.
Object.assign(process.env, {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-3.8-flash",
  GEMINI_FALLBACK_MODEL: "gemini-3.5-flash-lite",
  GEMINI_THINKING_LEVEL: "medium",
});
