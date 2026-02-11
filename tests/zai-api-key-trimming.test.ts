import { describe, expect, it } from "vitest";
import { resolveZaiApiKey } from "../src/fetchers/zai.js";

describe("Zai API Key Resolution", () => {
  it("should trim whitespace from environment variable API key", () => {
    const originalEnv = process.env.Z_AI_API_KEY;
    try {
      process.env.Z_AI_API_KEY = "  key-with-spaces  \n";
      const result = resolveZaiApiKey({});
      expect(result).toBe("key-with-spaces");
    } finally {
      if (originalEnv !== undefined) {
        process.env.Z_AI_API_KEY = originalEnv;
      } else {
        delete process.env.Z_AI_API_KEY;
      }
    }
  });

  it("should trim whitespace from piAuth.access field", () => {
    const piAuth = {
      "z-ai": {
        access: "  access-key-with-spaces  ",
      },
    };
    const result = resolveZaiApiKey(piAuth);
    expect(result).toBe("access-key-with-spaces");
  });

  it("should trim whitespace from piAuth.key field", () => {
    const piAuth = {
      zai: {
        key: "  \tkey-with-tabs  \n",
      },
    };
    const result = resolveZaiApiKey(piAuth);
    expect(result).toBe("key-with-tabs");
  });

  it("should prefer environment variable over piAuth", () => {
    const originalEnv = process.env.Z_AI_API_KEY;
    try {
      process.env.Z_AI_API_KEY = "  env-key  ";
      const piAuth = {
        "z-ai": {
          key: "  auth-key  ",
        },
      };
      const result = resolveZaiApiKey(piAuth);
      expect(result).toBe("env-key");
    } finally {
      if (originalEnv !== undefined) {
        process.env.Z_AI_API_KEY = originalEnv;
      } else {
        delete process.env.Z_AI_API_KEY;
      }
    }
  });

  it("should prefer access over key in piAuth", () => {
    const piAuth = {
      "z-ai": {
        access: "  access-key  ",
        key: "  key-field  ",
      },
    };
    const result = resolveZaiApiKey(piAuth);
    expect(result).toBe("access-key");
  });

  it("should return undefined for empty string after trimming", () => {
    const originalEnv = process.env.Z_AI_API_KEY;
    try {
      process.env.Z_AI_API_KEY = "   ";
      const result = resolveZaiApiKey({});
      expect(result).toBeUndefined();
    } finally {
      if (originalEnv !== undefined) {
        process.env.Z_AI_API_KEY = originalEnv;
      } else {
        delete process.env.Z_AI_API_KEY;
      }
    }
  });

  it("should handle zai alias in piAuth", () => {
    const piAuth = {
      zai: {
        access: "  zai-access-key  ",
      },
    };
    const result = resolveZaiApiKey(piAuth);
    expect(result).toBe("zai-access-key");
  });

  it("should return undefined when no valid API key is found", () => {
    const originalEnv = process.env.Z_AI_API_KEY;
    try {
      delete process.env.Z_AI_API_KEY;
      const result = resolveZaiApiKey({});
      expect(result).toBeUndefined();
    } finally {
      if (originalEnv !== undefined) {
        process.env.Z_AI_API_KEY = originalEnv;
      } else {
        delete process.env.Z_AI_API_KEY;
      }
    }
  });
});
