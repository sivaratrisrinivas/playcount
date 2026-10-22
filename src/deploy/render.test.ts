import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const blueprint = readFileSync(new URL("../../render.yaml", import.meta.url), "utf8");

// Each `- key: NAME` entry of the blueprint, with the settings lines under it.
function envVarsOf(yaml: string) {
  const entries = yaml.matchAll(/- key: (\w+)\n((?:(?!\s*- key:).*\n?)*)/g);
  return [...entries].map(([, key = "", settings = ""]) => ({ key, settings }));
}

const envVars = envVarsOf(blueprint);

it("declares the secrets the service needs", () => {
  expect(envVars.map((v) => v.key)).toEqual(
    expect.arrayContaining(["PLAYCOUNT_DEMO_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "GROQ_API_KEY", "ASSEMBLYAI_API_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]),
  );
});

it("never holds a secret's value: each is set in Render or generated there", () => {
  for (const { key, settings } of envVars.filter((v) => /KEY|SECRET|TOKEN|CLIENT_ID/.test(v.key))) {
    expect(settings, key).toMatch(/^\s*(sync: false|generateValue: true)\s*$/m);
    expect(settings, key).not.toMatch(/^\s*value:/m);
  }
});

it("checks health on the endpoint the service serves", () => {
  expect(blueprint).toMatch(/^\s*healthCheckPath: \/health$/m);
});
