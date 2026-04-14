const fs = require("node:fs");
const path = require("node:path");
const { zodToJsonSchema } = require("zod-to-json-schema");
const contracts = require("../dist/index.js");

const schemaOutputDir = path.join(__dirname, "..", "dist", "schemas");
fs.mkdirSync(schemaOutputDir, { recursive: true });

const schemaMap = {
  "agent-definition": contracts.AgentDefinitionSchema,
  "workflow-definition": contracts.WorkflowDefinitionSchema,
  "mission-run": contracts.MissionRunSchema,
  "telemetry-event": contracts.TelemetryEventSchema,
  "memory-record": contracts.MemoryRecordSchema,
  "artifact-record": contracts.ArtifactRecordSchema,
  "mission-action": contracts.MissionActionSchema
};

for (const [name, schema] of Object.entries(schemaMap)) {
  const jsonSchema = zodToJsonSchema(schema, name);
  fs.writeFileSync(
    path.join(schemaOutputDir, `${name}.json`),
    JSON.stringify(jsonSchema, null, 2),
    "utf8"
  );
}
