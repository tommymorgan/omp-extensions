import { z } from "zod";

export const CONTEXT_PUBLISH_CHANNEL = "trailboss:context:publish";

export const ContextMarker = z.object({
  source: z.string().min(1),
  sessionId: z.string().min(1),
});

export const ContextPublication = ContextMarker.extend({
  message: z.object({
    customType: z.string().min(1),
    content: z.string(),
    display: z.literal(false),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  accept: z.custom<() => void>(value => typeof value === "function"),
});
export type ContextPublication = z.infer<typeof ContextPublication>;

export const GeneratedContext = z.object({
  role: z.literal("custom"),
  details: z.object({ trailbossContext: ContextMarker }),
});
