import { z } from "zod";

/**
 * Value expressions, data typing, and sensitivity.
 *
 * Design note: every value a step consumes is an *expression*, never a bare
 * string. That is what makes a recorded run parameterizable at compile time
 * (literal -> param) and what lets secrets stay out of the artifact by
 * construction rather than by scrubbing logs afterwards.
 */

export const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "lower_snake_case identifier");

export const Semver = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "semver");

/** Reference into the runtime secret store. The value never enters the artifact. */
export const SecretRef = z
  .string()
  .regex(/^[a-z0-9]+(?:\.[a-z0-9_-]+)+$/, "dotted secret path, e.g. tenant.acme.parabank.operator");

/**
 * How a value may be handled. Drives redaction in logs/evidence and whether an
 * output may be persisted at all. `secret` values are write-only: they can be
 * typed into a field, never read back out.
 */
export const Sensitivity = z.enum(["public", "internal", "pii", "secret"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

const JsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonValue =
  | z.infer<typeof JsonPrimitive>
  | JsonValue[]
  | { [k: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitive, z.array(JsonValue), z.record(JsonValue)]),
);

/**
 * Where a value comes from at replay time.
 *  - literal   : baked into the artifact (safe constants only)
 *  - param     : supplied by the calling agent per invocation
 *  - secret    : resolved from the secret store at the moment of use
 *  - binding   : captured earlier in *this* run (e.g. an account id read off a list page)
 *  - template  : string interpolation over the above, e.g. "Member ${member_id}"
 */
export const ValueExpr = z.discriminatedUnion("from", [
  z.object({ from: z.literal("literal"), value: JsonValue }),
  z.object({ from: z.literal("param"), param: Id }),
  z.object({ from: z.literal("secret"), secret: SecretRef }),
  z.object({ from: z.literal("binding"), binding: Id }),
  z.object({ from: z.literal("template"), template: z.string() }),
]);
export type ValueExpr = z.infer<typeof ValueExpr>;

/**
 * A deliberately small type system. Not full JSON Schema: the artifact is a
 * contract an agent calls, and a narrow vocabulary keeps replay coercion and
 * caller-side validation honest. `money` and `account_number` are domain types
 * because getting them wrong is a business incident, not a parse error.
 */
export type FieldType = z.infer<typeof FieldTypeBase> | { kind: "array"; items: FieldType } | {
  kind: "object";
  fields: Record<string, FieldType>;
};
const FieldTypeBase = z.union([
  z.object({ kind: z.literal("string"), pattern: z.string().optional(), maxLength: z.number().int().optional() }),
  z.object({ kind: z.literal("number"), min: z.number().optional(), max: z.number().optional() }),
  z.object({ kind: z.literal("integer"), min: z.number().int().optional(), max: z.number().int().optional() }),
  z.object({ kind: z.literal("boolean") }),
  z.object({ kind: z.literal("date"), format: z.enum(["iso-8601", "us-mdy"]).default("iso-8601") }),
  z.object({ kind: z.literal("money"), currency: z.string().length(3).default("USD") }),
  z.object({ kind: z.literal("account_number") }),
  z.object({ kind: z.literal("enum"), values: z.array(z.string()).min(1) }),
]);
export const FieldType: z.ZodType<FieldType, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    FieldTypeBase,
    z.object({ kind: z.literal("array"), items: FieldType }),
    z.object({ kind: z.literal("object"), fields: z.record(FieldType) }),
  ]),
);
