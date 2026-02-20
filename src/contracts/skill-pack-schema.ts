export const OPENCLAW_SKILL_PACK_SCHEMA_VERSION = "openclaw-skill-pack.v1" as const;

export const ORGX_AGENT_DOMAINS = [
  "engineering",
  "product",
  "design",
  "marketing",
  "sales",
  "operations",
  "orchestration",
] as const;

export type OrgxAgentDomainName = (typeof ORGX_AGENT_DOMAINS)[number];

export type ManifestConfigType = "openclaw_skills" | "openclawSkills" | "openclaw.skills" | "none";

const DOMAIN_SET = new Set<string>(ORGX_AGENT_DOMAINS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const DOMAIN_STRING_SCHEMA = {
  type: "string",
  minLength: 1,
} as const;

export const OPENCLAW_SKILLS_MAP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    engineering: DOMAIN_STRING_SCHEMA,
    product: DOMAIN_STRING_SCHEMA,
    design: DOMAIN_STRING_SCHEMA,
    marketing: DOMAIN_STRING_SCHEMA,
    sales: DOMAIN_STRING_SCHEMA,
    operations: DOMAIN_STRING_SCHEMA,
    orchestration: DOMAIN_STRING_SCHEMA,
  },
} as const;

export const OPENCLAW_SKILL_PACK_MANIFEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.useorgx.com/openclaw-skill-pack/v1.json",
  title: "OrgX OpenClaw Skill Pack Manifest",
  description: "Behavior config manifest for OpenClaw skill overrides by domain.",
  type: "object",
  additionalProperties: true,
  oneOf: [
    {
      type: "object",
      additionalProperties: true,
      properties: {
        schema_version: { type: "string", const: OPENCLAW_SKILL_PACK_SCHEMA_VERSION },
        openclaw_skills: OPENCLAW_SKILLS_MAP_JSON_SCHEMA,
      },
      required: ["openclaw_skills"],
    },
    {
      type: "object",
      additionalProperties: true,
      properties: {
        schema_version: { type: "string", const: OPENCLAW_SKILL_PACK_SCHEMA_VERSION },
        openclawSkills: OPENCLAW_SKILLS_MAP_JSON_SCHEMA,
      },
      required: ["openclawSkills"],
    },
    {
      type: "object",
      additionalProperties: true,
      properties: {
        schema_version: { type: "string", const: OPENCLAW_SKILL_PACK_SCHEMA_VERSION },
        openclaw: {
          type: "object",
          additionalProperties: true,
          properties: {
            skills: OPENCLAW_SKILLS_MAP_JSON_SCHEMA,
          },
          required: ["skills"],
        },
      },
      required: ["openclaw"],
    },
  ],
} as const;

function resolveManifestConfigType(manifest: Record<string, unknown>): {
  type: ManifestConfigType;
  rawMap: Record<string, unknown> | null;
  errors: string[];
} {
  const hasOpenclawSkills = hasOwn(manifest, "openclaw_skills");
  const hasOpenclawSkillsCamel = hasOwn(manifest, "openclawSkills");
  const openclaw = manifest.openclaw;
  const hasOpenclawNestedSkills = isRecord(openclaw) && hasOwn(openclaw, "skills");

  const errors: string[] = [];
  const selectedConfigTypes = [
    hasOpenclawSkills ? "openclaw_skills" : null,
    hasOpenclawSkillsCamel ? "openclawSkills" : null,
    hasOpenclawNestedSkills ? "openclaw.skills" : null,
  ].filter((value): value is ManifestConfigType => value !== null);

  if (selectedConfigTypes.length > 1) {
    errors.push(
      "manifest must define only one config container: openclaw_skills, openclawSkills, or openclaw.skills"
    );
  }

  if (hasOpenclawSkills) {
    const value = manifest.openclaw_skills;
    if (!isRecord(value)) {
      return {
        type: "openclaw_skills",
        rawMap: null,
        errors: [...errors, "manifest.openclaw_skills must be an object"],
      };
    }
    return { type: "openclaw_skills", rawMap: value, errors };
  }

  if (hasOpenclawSkillsCamel) {
    const value = manifest.openclawSkills;
    if (!isRecord(value)) {
      return {
        type: "openclawSkills",
        rawMap: null,
        errors: [...errors, "manifest.openclawSkills must be an object"],
      };
    }
    return { type: "openclawSkills", rawMap: value, errors };
  }

  if (hasOpenclawNestedSkills) {
    const value = openclaw.skills;
    if (!isRecord(value)) {
      return {
        type: "openclaw.skills",
        rawMap: null,
        errors: [...errors, "manifest.openclaw.skills must be an object"],
      };
    }
    return { type: "openclaw.skills", rawMap: value, errors };
  }

  return { type: "none", rawMap: null, errors };
}

export function validateOpenClawSkillPackManifest(manifest: unknown): {
  ok: boolean;
  configType: ManifestConfigType;
  openclaw_skills: Partial<Record<OrgxAgentDomainName, string>>;
  errors: string[];
} {
  if (!isRecord(manifest)) {
    return {
      ok: false,
      configType: "none",
      openclaw_skills: {},
      errors: ["manifest must be an object"],
    };
  }

  const errors: string[] = [];
  if ("schema_version" in manifest) {
    const version = manifest.schema_version;
    if (typeof version !== "string") {
      errors.push("manifest.schema_version must be a string");
    } else if (version.trim() !== OPENCLAW_SKILL_PACK_SCHEMA_VERSION) {
      errors.push(
        `manifest.schema_version must equal "${OPENCLAW_SKILL_PACK_SCHEMA_VERSION}"`
      );
    }
  }

  const { type, rawMap, errors: manifestConfigErrors } = resolveManifestConfigType(
    manifest
  );
  errors.push(...manifestConfigErrors);
  if (!rawMap) {
    return {
      ok: errors.length === 0,
      configType: type,
      openclaw_skills: {},
      errors,
    };
  }

  const openclaw_skills: Partial<Record<OrgxAgentDomainName, string>> = {};
  for (const [domain, rawValue] of Object.entries(rawMap)) {
    if (!DOMAIN_SET.has(domain)) {
      errors.push(`unknown domain key "${domain}" in manifest ${type}`);
      continue;
    }

    if (typeof rawValue !== "string") {
      errors.push(`manifest ${type}.${domain} must be a string`);
      continue;
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      errors.push(`manifest ${type}.${domain} must not be empty`);
      continue;
    }

    openclaw_skills[domain as OrgxAgentDomainName] = normalized;
  }

  return {
    ok: errors.length === 0,
    configType: type,
    openclaw_skills,
    errors,
  };
}
