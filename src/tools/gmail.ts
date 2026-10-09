import { google } from "googleapis";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

function getGmail(account: string) {
  const auth = getAuthenticatedClient(account);
  return google.gmail({ version: "v1", auth });
}

// RFC 2047: a raw non-ASCII Subject is read by Gmail as latin-1 (mojibake) and truncated (#1191).
// Encoded-words are capped at 75 chars, so split on character boundaries at <=45 UTF-8 bytes.
export function encodeHeader(value: string): string {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

type Mail = { to: string; subject: string; body: string; cc?: string; bcc?: string; inReplyTo?: string; references?: string };

export function buildRaw(m: Mail): string {
  const h = [`To: ${m.to}`, `Subject: ${encodeHeader(m.subject)}`, "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"];
  if (m.cc) h.push(`Cc: ${m.cc}`);
  if (m.bcc) h.push(`Bcc: ${m.bcc}`);
  if (m.inReplyTo) h.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.inReplyTo || m.references) h.push(`References: ${m.references ?? m.inReplyTo}`);
  const body = Buffer.from(m.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return Buffer.from(`${h.join("\r\n")}\r\n\r\n${body}`).toString("base64url");
}

const threadProps = {
  threadId: { type: "string", description: "Gmail thread ID to reply in (keeps the reply in the existing conversation)" },
  inReplyTo: { type: "string", description: "Message-ID header of the message being replied to, e.g. <abc@mail.gmail.com>" },
  references: { type: "string", description: "References header; defaults to inReplyTo" },
};

function accountDescription() {
  const names = getAccountNames();
  if (names.length === 0) return "No accounts configured.";
  return `Available accounts: ${names.join(", ")}`;
}

export const gmailTools = [
  {
    name: "gmail_search",
    description: `Search emails in a specific Google account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label (e.g. 'work', 'personal')" },
        query: { type: "string", description: "Gmail search query (same syntax as Gmail search bar)" },
        max_results: { type: "number", description: "Max emails to return (default 10)" },
      },
      required: ["account", "query"],
    },
    handler: async (args: { account: string; query: string; max_results?: number }) => {
      const gmail = getGmail(args.account);
      const res = await gmail.users.messages.list({
        userId: "me",
        q: args.query,
        maxResults: args.max_results || 10,
      });

      if (!res.data.messages || res.data.messages.length === 0) {
        return { content: [{ type: "text" as const, text: "No messages found." }] };
      }

      const messages = await Promise.all(
        res.data.messages.map(async (msg) => {
          const full = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });
          const headers = full.data.payload?.headers || [];
          const get = (name: string) => headers.find((h) => h.name === name)?.value || "";
          return {
            id: msg.id,
            subject: get("Subject"),
            from: get("From"),
            to: get("To"),
            date: get("Date"),
            snippet: full.data.snippet,
          };
        })
      );

      return { content: [{ type: "text" as const, text: JSON.stringify(messages, null, 2) }] };
    },
  },
  {
    name: "gmail_read",
    description: `Read a specific email by ID. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        message_id: { type: "string", description: "Gmail message ID" },
      },
      required: ["account", "message_id"],
    },
    handler: async (args: { account: string; message_id: string }) => {
      const gmail = getGmail(args.account);
      const res = await gmail.users.messages.get({
        userId: "me",
        id: args.message_id,
        format: "full",
      });

      const headers = res.data.payload?.headers || [];
      const get = (name: string) => headers.find((h) => h.name === name)?.value || "";

      // Extract body — prefer text/plain, fall back to text/html (stripped to text),
      // and only THEN the snippet. HTML-only emails (most newsletters + transactional
      // mail) carry no text/plain part; the old code found nothing and returned just the
      // snippet, truncating the body mid-sentence. Walk collects both and prefers plain.
      let plain = "";
      let html = "";
      function walk(part: any): void {
        const data = part?.body?.data;
        if (data) {
          if (part.mimeType === "text/plain") plain += Buffer.from(data, "base64url").toString("utf-8");
          else if (part.mimeType === "text/html") html += Buffer.from(data, "base64url").toString("utf-8");
        }
        if (part?.parts) part.parts.forEach(walk);
      }
      if (res.data.payload) walk(res.data.payload);

      const htmlToText = (h: string): string =>
        h
          .replace(/<!--[\s\S]*?-->/g, "")
          .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
          .replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|blockquote|table)>/gi, "\n")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/&quot;/gi, '"')
          .replace(/&#0?39;|&apos;/gi, "'")
          .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n))
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/[ \t]{2,}/g, " ")
          .trim();

      // Preferred order: real plain-text > HTML rendered to text > snippet (last resort).
      let body = plain.trim();
      if (!body && html.trim()) body = htmlToText(html);
      if (!body && res.data.snippet) body = res.data.snippet;

      const email = {
        id: res.data.id,
        subject: get("Subject"),
        from: get("From"),
        to: get("To"),
        date: get("Date"),
        body,
        labels: res.data.labelIds,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(email, null, 2) }] };
    },
  },
  {
    name: "gmail_send",
    description: `Send an email from a specific Google account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC recipients (comma-separated)" },
        bcc: { type: "string", description: "BCC recipients (comma-separated)" },
        ...threadProps,
      },
      required: ["account", "to", "subject", "body"],
    },
    handler: async (args: Mail & { account: string; threadId?: string }) => {
      const gmail = getGmail(args.account);
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: buildRaw(args), threadId: args.threadId },
      });

      return {
        content: [{ type: "text" as const, text: `Email sent. Message ID: ${res.data.id}` }],
      };
    },
  },
  {
    name: "gmail_draft",
    description: `Create a draft email in a specific Google account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC recipients (comma-separated)" },
        ...threadProps,
      },
      required: ["account", "to", "subject", "body"],
    },
    handler: async (args: Mail & { account: string; threadId?: string }) => {
      const gmail = getGmail(args.account);
      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw: buildRaw(args), threadId: args.threadId } },
      });

      return {
        content: [{ type: "text" as const, text: `Draft created. Draft ID: ${res.data.id}` }],
      };
    },
  },
  {
    name: "gmail_list_labels",
    description: `List all labels in a Gmail account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
      },
      required: ["account"],
    },
    handler: async (args: { account: string }) => {
      const gmail = getGmail(args.account);
      const res = await gmail.users.labels.list({ userId: "me" });
      const labels = (res.data.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
      return { content: [{ type: "text" as const, text: JSON.stringify(labels, null, 2) }] };
    },
  },
];
