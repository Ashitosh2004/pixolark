import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { Loader } from "@/components/pixel/ui";

const PixelApp = lazy(() => import("@/components/pixel/PixelApp"));

export const Route = createFileRoute("/chat")({
  validateSearch: (s: Record<string, unknown>): {
    mode?: "create" | "join" | undefined;
    code?: string | undefined;
    room?: string | undefined;
  } => ({
    mode: s["mode"] === "create" || s["mode"] === "join" ? s["mode"] : (s["code"] ? "join" : undefined),
    code: typeof s["code"] === "string" ? s["code"] : undefined,
    room: typeof s["room"] === "string" ? s["room"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Room — Pixolark" },
      { name: "description", content: "Create or join an end-to-end encrypted peer-to-peer Pixolark room." },
      { property: "og:title", content: "Pixolark room" },
      { property: "og:description", content: "Create or join an encrypted peer-to-peer chat room. No account needed." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ChatRoute,
});

function ChatRoute() {
  const { mode, code, room } = Route.useSearch();
  const fallback = <div className="flex min-h-dvh items-center justify-center"><Loader label="Booting" /></div>;
  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>
        <PixelApp mode={mode} initialCode={code} initialRoom={room} />
      </Suspense>
    </ClientOnly>
  );
}
