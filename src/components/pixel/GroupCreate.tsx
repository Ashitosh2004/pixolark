/**
 * GroupCreate — multi-step wizard for hosting a new group room.
 * Everything is decided here once and baked into the GroupMeta the host publishes:
 * visibility (Discover listing vs private invite), approval gate, history sharing.
 */
import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, Lock, Sparkles } from "lucide-react";
import { CATEGORIES, LANGUAGES, REGIONS } from "@/lib/pixel/discovery";
import type { GroupMeta } from "@/lib/pixel/group";
import { cn } from "@/lib/utils";
import { Loader } from "./ui";

const STEPS = ["Basics", "Community", "Privacy"] as const;

const REGION_OPTIONS = Object.entries(REGIONS).flatMap(([key, node]) => [
  { value: key, label: node.name },
  ...(node.children ?? []).map((c) => ({ value: `${key} · ${c}`, label: `${node.name} — ${c}` })),
]);

export function GroupCreate({ busy, onCreate, onCancel }: {
  busy: boolean;
  onCreate: (meta: Partial<GroupMeta>) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [cat, setCat] = useState<string>("General Chat");
  const [region, setRegion] = useState("International");
  const [lang, setLang] = useState<string>("English");
  const [isPublic, setIsPublic] = useState(true);
  const [approval, setApproval] = useState(false);
  const [historyShare, setHistoryShare] = useState(false);
  const [cap, setCap] = useState(12);

  const canNext = useMemo(() => step !== 0 || name.trim().length >= 2, [step, name]);

  const submit = () => onCreate({
    name: name.trim().slice(0, 48),
    desc: desc.trim().slice(0, 160),
    cat, region, lang,
    isPublic, approval: !isPublic ? approval : false,
    historyShare, cap: Math.max(2, Math.min(24, cap)),
  });

  return (
    <div className="mx-auto w-full max-w-xl">
      <button className="pixel-btn pixel-btn-sm mb-4" onClick={onCancel}><ArrowLeft size={12} /> Back</button>
      <div className="pixel-box flex flex-col gap-4 p-5">
        <div className="flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <span className={cn("pixel-label", i === step ? "text-primary" : i < step ? "text-secondary" : "opacity-50")}>
                {i + 1}. {s}
              </span>
              {i < STEPS.length - 1 && <span className="text-muted-foreground">›</span>}
            </div>
          ))}
        </div>

        {step === 0 && (
          <>
            <label className="flex flex-col gap-1">
              <span className="pixel-label">Group name *</span>
              <input autoFocus className="pixel-input" value={name} maxLength={48} placeholder="e.g. Pixel Garden" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="pixel-label">Description</span>
              <input className="pixel-input" value={desc} maxLength={160} placeholder="What is this room about?" onChange={(e) => setDesc(e.target.value)} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1"><span className="pixel-label">Capacity</span>
                <input className="pixel-input" type="number" min={2} max={24} value={cap} onChange={(e) => setCap(Number(e.target.value) || 12)} /></label>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <label className="flex flex-col gap-1">
              <span className="pixel-label">Category</span>
              <select className="pixel-input" value={cat} onChange={(e) => setCat(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="pixel-label">Region</span>
                <select className="pixel-input" value={region} onChange={(e) => setRegion(e.target.value)}>
                  {REGION_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="pixel-label">Language</span>
                <select className="pixel-input" value={lang} onChange={(e) => setLang(e.target.value)}>
                  {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <button className={cn("pixel-btn flex items-start gap-3 text-left", isPublic ? "pixel-btn-primary" : "")} onClick={() => setIsPublic(true)}>
              <Globe size={18} className="mt-0.5 shrink-0" />
              <span>
                <span className="block font-semibold">Public room</span>
                <span className="block text-xs opacity-80">Listed in Discover. Anyone can find and join it.</span>
              </span>
            </button>
            <button className={cn("pixel-btn flex items-start gap-3 text-left", !isPublic ? "pixel-btn-primary" : "")} onClick={() => setIsPublic(false)}>
              <Lock size={18} className="mt-0.5 shrink-0" />
              <span>
                <span className="block font-semibold">Private room</span>
                <span className="block text-xs opacity-80">Unlisted. People join only with your room code.</span>
              </span>
            </button>
            {!isPublic && (
              <label className="flex items-center gap-3 border-2 border-border bg-surface p-3 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
                <span>Approve each join request manually <span className="block text-xs text-muted-foreground">New arrivals wait until you or an admin accepts them.</span></span>
              </label>
            )}
            <label className="flex items-center gap-3 border-2 border-border bg-surface p-3 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={historyShare} onChange={(e) => setHistoryShare(e.target.checked)} />
              <span>Share recent history with newcomers <span className="block text-xs text-muted-foreground">Members who opted into local history replay their recent messages to approved newcomers. Off by default.</span></span>
            </label>
          </>
        )}

        {busy ? <Loader label="Opening room" /> : (
          <div className="flex justify-between gap-2">
            <button className="pixel-btn" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}><ArrowLeft size={12} /> Back</button>
            {step < STEPS.length - 1
              ? <button className="pixel-btn pixel-btn-primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}><Sparkles size={12} /> Next <ArrowRight size={12} /></button>
              : <button className="pixel-btn pixel-btn-primary" disabled={!canNext} onClick={submit}>▶ Open room</button>}
          </div>
        )}
      </div>
    </div>
  );
}
