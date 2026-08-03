import { defineConfig } from "@playwright/test";

// Les tests e2e pilotent leur propre contexte persistant (obligatoire pour
// charger une extension), donc pas de `use.browserName` ici.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 1 : 0,
});
