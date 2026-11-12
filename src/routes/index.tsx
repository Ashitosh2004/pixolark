import { createFileRoute, Link } from "@tanstack/react-router";
import { Lock, Wifi, UserX, Database, QrCode, KeyRound, ShieldAlert, Video, Smile, Paperclip } from "lucide-react";
import world from "@/assets/pixel-world.jpg";
import { Mascot, PixelBackground } from "@/components/pixel/ui";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pixolark — Your conversations. Your world. Your privacy." },
      { name: "description", content: "A retro pixel-art messenger with end-to-end encryption, direct peer-to-peer chat, calls and file sharing. No account needed." },
      { property: "og:title", content: "Pixolark — Private pixel-art messenger" },
      { property: "og:description", content: "End-to-end encrypted P2P chat, calls and files in a retro 8-bit world. No accounts, no database." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const STEPS = [
  { icon: QrCode, title: "1. Create a room", text: "You get a random Room ID plus a connection code and QR. The code holds only public connection info." },
  { icon: Wifi, title: "2. Friend answers", text: "Your friend enters the Room ID, scans your QR (or pastes the code) and sends back an answer code." },
  { icon: KeyRound, title: "3. Keys are verified", text: "Browsers connect directly, exchange encryption keys and check them against the codes. Compare the safety code to be sure." },
  { icon: Lock, title: "4. Chat privately", text: "Messages, files, stickers and voice notes are encrypted before they leave your device." },
];

const FEATURES = [
  { icon: Smile, label: "Emojis, stickers & GIFs" },
  { icon: Paperclip, label: "Encrypted file sharing" },
  { icon: Video, label: "Voice & video calls" },
  { icon: UserX, label: "No account needed" },
  { icon: Database, label: "No database, no cloud" },
  { icon: Lock, label: "AES-GCM + ECDH" },
];

function Landing() {
  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <PixelBackground dense />
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <span className="font-pixel text-sm text-primary">PIXO<span className="text-secondary">LARK</span></span>
        <Link to="/chat" search={{ mode: "join" }} className="pixel-btn pixel-btn-sm">Join room</Link>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-12 pt-6 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <Mascot size={84} className="animate-bob mb-6" />
          <h1 className="font-pixel text-2xl leading-relaxed text-foreground sm:text-4xl sm:leading-[1.5]">
            PIXO<br /><span className="text-primary">LARK</span>
          </h1>
          <p className="mt-5 font-pixel text-[11px] leading-loose text-secondary sm:text-xs">Your conversations. Your world. Your privacy.</p>
          <p className="mt-5 max-w-lg text-base text-muted-foreground">
            A peer-to-peer messenger where your browser talks directly to your friend's. Everything is end-to-end encrypted. No sign-up, no servers storing your messages.
          </p>
          <div className="mt-8 flex flex-wrap gap-5">
            <Link to="/chat" search={{ mode: "create" }} className="pixel-btn pixel-btn-primary text-xs">▶ Create room</Link>
            <Link to="/chat" search={{ mode: "join" }} className="pixel-btn pixel-btn-gold text-xs">Join room</Link>
          </div>
          <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><UserX size={16} className="text-primary" /> No account required. Just pick a name and play.</p>
        </div>
        <div className="pixel-box relative overflow-hidden">
          <img src={world} width={1536} height={768} alt="Pixel-art night village with a glowing radio tower" className="pixelated block h-auto w-full" />
          <div className="pixel-surface animate-bob absolute left-[8%] top-[10%] px-3 py-2 font-pixel text-[9px] text-foreground">hey! 👋</div>
          <div className="bubble bubble-me animate-bob absolute right-[8%] top-[24%] px-3 py-2 font-pixel text-[9px]" style={{ animationDelay: "0.4s" }}>🔒 encrypted</div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-12">
        <h2 className="font-pixel text-sm text-secondary">How it works</h2>
        <div className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.title} className="pixel-box p-5">
              <s.icon className="text-primary" size={22} />
              <h3 className="mt-4 font-pixel text-[10px] text-foreground">{s.title}</h3>
              <p className="mt-3 text-sm text-muted-foreground">{s.text}</p>
            </div>
          ))}
        </div>
        <p className="mt-8 max-w-3xl text-sm text-muted-foreground">
          <strong className="text-foreground">Why codes and not just a Room ID?</strong> Two browsers can't find each other from a Room ID alone — they must swap connection details (signaling). Pixolark does that by hand through QR/copy codes, so no server ever sits in the middle.
        </p>
      </section>

      <section className="mx-auto grid max-w-6xl gap-8 px-5 py-12 lg:grid-cols-2">
        <div className="pixel-box p-6">
          <h2 className="font-pixel text-sm text-primary">Encryption</h2>
          <ul className="mt-5 space-y-3 text-sm text-muted-foreground">
            <li>• Fresh ECDH P-256 keys every session, kept only in memory.</li>
            <li>• HKDF-SHA-256 derives separate AES-GCM-256 keys per direction.</li>
            <li>• Every message gets a unique random nonce and replay protection; tampered data stops the chat.</li>
            <li>• Keys are bound to the room and the WebRTC DTLS fingerprints; a safety code lets you verify each other.</li>
            <li>• Calls use WebRTC's built-in DTLS-SRTP encryption.</li>
          </ul>
        </div>
        <div className="pixel-box p-6">
          <h2 className="flex items-center gap-2 font-pixel text-sm text-secondary"><ShieldAlert size={16} /> Honest limits</h2>
          <ul className="mt-5 space-y-3 text-sm text-muted-foreground">
            <li>• Not independently audited. No software is perfectly secure.</li>
            <li>• Direct P2P links reveal your IP address to the other person; public STUN servers see connection metadata.</li>
            <li>• A compromised device, malicious extension or tampered website code can read messages.</li>
            <li>• Optional GIF search sends your search terms to the GIF provider.</li>
            <li>• Clearing your history never deletes what the other person already received.</li>
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20 pt-6">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-6">
          {FEATURES.map((f) => (
            <div key={f.label} className="pixel-surface flex flex-col items-center gap-3 p-4 text-center">
              <f.icon size={20} className="text-primary" />
              <span className="text-xs text-foreground">{f.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-12 flex justify-center">
          <Link to="/chat" search={{ mode: "create" }} className="pixel-btn pixel-btn-primary text-xs">▶ Start a private room</Link>
        </div>
      </section>
      <footer className="border-t-4 border-border px-5 py-6 text-center text-xs text-muted-foreground">
        Pixolark · peer-to-peer · no accounts · no message storage
      </footer>
    </div>
  );
}
