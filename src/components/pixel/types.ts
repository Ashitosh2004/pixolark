import type { Avatar } from "@/lib/pixel/pixelart";

export type MsgKind = "text" | "sticker" | "file" | "voice" | "gif" | "system";
export interface FileInfo { name: string; size: number; mime: string; url?: string | undefined; progress: number; status: "sending" | "receiving" | "done" | "cancelled" | "failed" }
export interface ReplyRef { id: string; author: string; preview: string }
export interface ChatMessage {
  id: string;
  from: "me" | "peer" | "system";
  kind: MsgKind;
  text?: string | undefined;
  sticker?: string | undefined; // built-in sticker id
  stickerUrl?: string | undefined; // custom sticker data URL
  file?: FileInfo | undefined;
  ts: number;
  status?: "sending" | "sent" | "delivered" | "read" | "failed" | undefined;
  replyTo?: ReplyRef | undefined;
  reactions: Record<string, ("me" | "peer")[]>;
  pinned?: boolean | undefined;
  forwarded?: boolean | undefined;
  senderName?: string | undefined; // groups: display name of the sender
  senderId?: string | undefined; // groups: member id of the sender (moderation/jump)
  edited?: boolean | undefined;
  deleted?: boolean | undefined;
}
export interface PeerProfile { name: string; avatar: Avatar; status: string; stickerLib?: string | undefined }
export type CallPhase = "idle" | "outgoing" | "incoming" | "active";
export interface CallState { phase: CallPhase; video: boolean; startedAt: number | null; micOn: boolean; camOn: boolean; incomingVideo?: boolean | undefined }

export const MAX_FILE_BYTES = 250 * 1024 * 1024;
export const MAX_TEXT = 4000;
export const CHUNK = 64 * 1024;

export function previewOf(m: ChatMessage): string {
  if (m.kind === "text") return (m.text ?? "").slice(0, 80);
  if (m.kind === "sticker") return "[sticker]";
  if (m.kind === "voice") return "[voice message]";
  if (m.kind === "gif") return "[GIF]";
  if (m.kind === "file") return `[file] ${m.file?.name ?? ""}`;
  return m.text ?? "";
}
