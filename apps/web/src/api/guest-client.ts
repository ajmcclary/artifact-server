import {z} from "zod";

import type {CommentsTransport} from "@/review/review-comments";

import {commentSchemas, request, requestNoContent} from "./client";

const guestContextSchema = z.object({
  artifact: z.object({id: z.string(), name: z.string()}),
  guest: z.object({displayName: z.string().nullable(), id: z.string()}),
  link: z.object({
    createdByName: z.string(),
    expiresAt: z.string().nullable(),
    id: z.string(),
    label: z.string(),
    permissions: z.array(z.string()),
  }),
  project: z.object({id: z.string(), name: z.string()}),
  version: z.object({id: z.string(), number: z.number().int(), savedAt: z.string()}),
});

/** Where a guest is: the link, its one artifact and version, and the name they gave. */
export type GuestContext = z.infer<typeof guestContextSchema>;

const contextResponseSchema = z.object({context: guestContextSchema});

// The session answer carries the CSRF token; after a reload it is read back from its cookie.
let csrfToken: string | null = null;

function cookieValue(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function guestCsrf(): string {
  return csrfToken ?? cookieValue("__Host-artifact_guest_csrf") ?? cookieValue("artifact_guest_csrf") ?? "";
}

function writeHeaders(idempotencyKey?: string): Headers {
  const headers = new Headers({"Content-Type": "application/json", "X-CSRF-Token": guestCsrf()});
  if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
  return headers;
}

const thread = (threadId: string) => `/api/v1/share/threads/${encodeURIComponent(threadId)}`;

/** The guest's own API: only the /api/v1/share routes, with the guest cookie and guest CSRF token. */
export const guestApi = {
  /** Exchange a link token for a guest session. The token travels only in this request body. */
  startSession: async (token: string): Promise<GuestContext> => {
    const started = await request(
      contextResponseSchema.extend({csrfToken: z.string()}),
      "/api/v1/share/sessions",
      {body: JSON.stringify({token}), headers: {"Content-Type": "application/json"}, method: "POST"},
    );
    csrfToken = started.csrfToken;
    return started.context;
  },
  session: () => request(contextResponseSchema, "/api/v1/share/session").then(({context}) => context),
  setIdentity: (displayName: string, contactEmail: string | null) => request(
    contextResponseSchema,
    "/api/v1/share/session/identity",
    {body: JSON.stringify({contactEmail, displayName}), headers: writeHeaders(), method: "PUT"},
  ).then(({context}) => context),
  previewLease: () => request(
    z.object({baseUrl: z.url(), expiresAt: z.string(), versionId: z.string()}),
    "/api/v1/share/preview-lease",
    {headers: writeHeaders(), method: "POST"},
  ),
};

/** Comment calls bounded to the link's version; the server chooses the version, never the guest. */
export const guestCommentsTransport: CommentsTransport = {
  createReply: async (threadId, body, idempotencyKey) => {
    await request(commentSchemas.createdReply, `${thread(threadId)}/replies`, {
      body: JSON.stringify({body}),
      headers: writeHeaders(idempotencyKey),
      method: "POST",
    });
  },
  createThread: async (_versionId, draft, idempotencyKey) => {
    const created = await request(commentSchemas.createdThread, "/api/v1/share/threads", {
      body: JSON.stringify(draft.path === null ? {anchor: draft.anchor, body: draft.body} : draft),
      headers: writeHeaders(idempotencyKey),
      method: "POST",
    });
    return created.thread;
  },
  deleteReply: (threadId, replyId) => requestNoContent(
    `${thread(threadId)}/replies/${encodeURIComponent(replyId)}`,
    {headers: writeHeaders(), method: "DELETE"},
  ),
  getThread: (threadId) => request(commentSchemas.threadDetails, thread(threadId)),
  listThreads: (_versionId, cursor) =>
    request(commentSchemas.threadPage, `/api/v1/share/threads?${new URLSearchParams(cursor === null ? {} : {cursor})}`),
  setThreadState: async (threadId, state) => {
    await request(
      z.object({thread: commentSchemas.thread}),
      `${thread(threadId)}/${state === "resolved" ? "resolve" : "reopen"}`,
      {headers: writeHeaders(), method: "POST"},
    );
  },
  updateReply: async (threadId, replyId, body) => {
    await request(z.object({reply: z.object({id: z.string()}).loose()}), `${thread(threadId)}/replies/${encodeURIComponent(replyId)}`, {
      body: JSON.stringify({body}),
      headers: writeHeaders(),
      method: "PATCH",
    });
  },
};
