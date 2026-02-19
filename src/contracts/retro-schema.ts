export const RETRO_ARTIFACT_SCHEMA_VERSION = 'retro.v1' as const;

export type RetroArtifactSchemaVersion = typeof RETRO_ARTIFACT_SCHEMA_VERSION;

export const RETRO_ARTIFACT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.useorgx.com/retro-artifact/v1.json',
  title: 'OrgX Run Retro Artifact v1',
  description:
    'Structured post-run retrospective artifact emitted by OpenClaw/OrgX execution paths.',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'summary'],
  properties: {
    schema_version: {
      type: 'string',
      const: RETRO_ARTIFACT_SCHEMA_VERSION,
      description: 'Version marker for safe schema evolution.',
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description: 'Required high-level run retrospective summary.',
    },
    what_went_well: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
      },
    },
    what_went_wrong: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
      },
    },
    decisions: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
      },
    },
    follow_ups: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
          },
          priority: {
            type: 'string',
            enum: ['p0', 'p1', 'p2'],
          },
          reason: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
          },
        },
      },
    },
    signals: {
      type: 'object',
      additionalProperties: true,
      description: 'Telemetry-style structured metadata for analytics and drill-down.',
    },
  },
} as const;
