import { z } from "zod";

/**
 * Webhook event types emitted by Kan.bn.
 * Mirrors `webhookEvents` in kan's packages/db/src/schema/webhooks.ts.
 */
export const KAN_WEBHOOK_EVENTS = [
  "card.created",
  "card.updated",
  "card.moved",
  "card.deleted",
  "card.comment.created",
  "card.comment.updated",
  "card.comment.deleted",
  "card.label.added",
  "card.label.removed",
  "card.member.added",
  "card.member.removed",
] as const;

export type KanWebhookEvent = (typeof KAN_WEBHOOK_EVENTS)[number];

export function isKanWebhookEvent(value: string): value is KanWebhookEvent {
  return (KAN_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

const cardSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  dueDate: z.string().nullish(),
  listId: z.string(),
  boardId: z.string(),
});

const boardSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const listSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const actorSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
});

const commentSchema = z.object({
  id: z.string(),
  text: z.string(),
});

const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  colourCode: z.string().nullish(),
});

const memberSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  email: z.string().optional(),
});

const changeSchema = z.object({
  from: z.unknown(),
  to: z.unknown(),
});

/**
 * Payload sent by Kan.bn webhooks.
 * Mirrors `WebhookPayload` in kan's packages/api/src/utils/webhook.ts.
 */
export const kanWebhookPayloadSchema = z.object({
  event: z.enum(KAN_WEBHOOK_EVENTS),
  timestamp: z.string().datetime(),
  data: z.object({
    card: cardSchema,
    board: boardSchema.optional(),
    list: listSchema.optional(),
    user: actorSchema.optional(),
    comment: commentSchema.optional(),
    label: labelSchema.optional(),
    member: memberSchema.optional(),
    changes: z.record(z.string(), changeSchema).optional(),
  }),
});

export type KanWebhookPayload = z.infer<typeof kanWebhookPayloadSchema>;
export type KanCard = KanWebhookPayload["data"]["card"];
export type KanChanges = NonNullable<KanWebhookPayload["data"]["changes"]>;

export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}

export function parseKanWebhookPayload(body: unknown): KanWebhookPayload {
  const result = kanWebhookPayloadSchema.safeParse(body);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new WebhookPayloadError(`Invalid webhook payload: ${issues}`);
  }

  return result.data;
}
