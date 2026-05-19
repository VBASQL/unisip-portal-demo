import { useState, useCallback, useEffect } from "react";

/* ─── helpers ─── */
const uid = () => Math.random().toString(36).slice(2, 8);
const ACTIONS = ["Extension (SIP)", "Ring group", "Forward to number", "Voicemail", "Submenu", "Announcement"];
const defaultOption = () => ({
  id: uid(), label: "", action: "Extension (SIP)", target: "", targets: [],
  whisper: "", submenuIntro: "",
  fallbacks: [{ type: "Voicemail", target: "" }],
  timeRules: [],
  children: [], vmGreeting: "", announcement: "",
});
const generatePrompt = (opts) => {
  if (!opts.length) return "";
  const parts = opts.map((o, i) => `press ${i + 1} for ${o.label.toLowerCase()}`);
  return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + ", or " + parts[parts.length - 1];
};

/* ─── initial data ─── */
const GREETINGS = [
  { id: "main", label: "Main (business hours)", text: "Thank you for calling the UniSip family of fine-beverage companies. Please listen carefully for our updated menu. If you know your party's extension, you can dial it anytime.", schedule: null },
  { id: "after", label: "After hours", text: "Thank you for calling UniSip. You have reached us after regular business hours, which are nine to five, Monday through Thursday, and nine to one on Fridays. Please choose from the following options to leave a message.", schedule: { type: "auto", rule: "Outside business hours" } },
  { id: "yomtov", label: "Yom Tov / Holiday", text: "Thank you for calling UniSip. Our offices are currently closed in observance of Shavuos. We will be back on Monday, June 5th. Please choose from the following options to leave a message.", schedule: { type: "custom", start: "2026-06-01", end: "2026-06-04", startNow: false } },
];

const MENU_OPTIONS = [
  { id: uid(), label: "Orders", action: "Submenu", target: "", targets: [], whisper: "Incoming orders call", submenuIntro: "You've reached our orders department.", fallbacks: [{ type: "Voicemail", target: "" }], vmGreeting: "We would love to speak with you directly, but are busy helping another customer. Please leave your name, number, and order details.", announcement: "",
    children: [
      { id: uid(), label: "Catskills & summer", action: "Ring group", target: "", targets: ["101","102"], whisper: "Catskills sales", submenuIntro: "", fallbacks: [{ type: "Forward to number", target: "+1 (555) 999-0000" }, { type: "Voicemail", target: "" }], timeRules: [{ id: uid(), label: "Fri early close", days: [5], allDay: false, startTime: "13:00", endTime: "23:59", action: "Forward to number", target: "+1 (555) 999-0000", targets: [] }], children: [], vmGreeting: "", announcement: "" },
      { id: uid(), label: "National sales", action: "Extension (SIP)", target: "103", targets: [], whisper: "", submenuIntro: "", fallbacks: [{ type: "Voicemail", target: "" }], children: [], vmGreeting: "", announcement: "" },
      { id: uid(), label: "Customer support", action: "Forward to number", target: "+1 (718) 555-0199", targets: [], whisper: "Customer support call", submenuIntro: "", fallbacks: [{ type: "Voicemail", target: "" }], children: [], vmGreeting: "", announcement: "" },
    ] },
  { id: uid(), label: "Shipping & receiving", action: "Voicemail", target: "", targets: [], whisper: "", submenuIntro: "", fallbacks: [], vmGreeting: "Dear Driver: We are busy loading shipments. Please leave your name, number, and a message.", announcement: "", children: [] },
  { id: uid(), label: "Accounts receivable", action: "Extension (SIP)", target: "201", targets: [], whisper: "AR call", submenuIntro: "", fallbacks: [{ type: "Forward to number", target: "+1 (917) 555-1234" }, { type: "Voicemail", target: "" }], timeRules: [{ id: uid(), label: "After hours (weekdays)", days: [1,2,3,4], allDay: false, startTime: "17:00", endTime: "09:00", action: "Forward to number", target: "+1 (917) 555-1234", targets: [] }, { id: uid(), label: "Fri early close", days: [5], allDay: false, startTime: "13:00", endTime: "23:59", action: "Voicemail", target: "", targets: [] }], vmGreeting: "", announcement: "", children: [] },
  { id: uid(), label: "Accounts payable", action: "Extension (SIP)", target: "202", targets: [], whisper: "", submenuIntro: "", fallbacks: [{ type: "Voicemail", target: "" }], vmGreeting: "", announcement: "", children: [] },
  { id: uid(), label: "Hours & addresses", action: "Announcement", target: "", targets: [], whisper: "", submenuIntro: "", fallbacks: [], vmGreeting: "", announcement: "We are located at 626 Whittier Street, Bronx, NY 10474. Hours: 9-5 Mon-Thu, 9-1 Friday.", children: [] },
];

const USERS = [
  { id: "usr-003", name: "Carol Davis", phone: "+1 (555) 555-5555", ext: "100", dept: "Operations", role: "admin", email: "carol@unisip.com", client: "Zoiper", status: "online", vmEmail: true, canCallOut: true },
  { id: "usr-001", name: "Moshe Klein", phone: "+1 (555) 123-4567", ext: "101", dept: "Sales", role: "user", email: "moshe@unisip.com", client: "MicroSIP", status: "oncall", vmEmail: true, canCallOut: true },
  { id: "usr-002", name: "Chaim Berger", phone: "+1 (555) 987-6543", ext: "102", dept: "Sales", role: "user", email: "chaim@unisip.com", client: "Zoiper iOS", status: "online", vmEmail: false, canCallOut: true },
  { id: "usr-004", name: "Avi Klein", phone: "+1 (555) 222-3333", ext: "", dept: "Sales", role: "user", email: "avi@unisip.com", client: "", status: "online", vmEmail: true, canCallOut: false },
  { id: "usr-005", name: "David Stern", phone: "+1 (555) 444-5555", ext: "201", dept: "Support", role: "user", email: "david@unisip.com", client: "MicroSIP", status: "offline", vmEmail: true, canCallOut: true },
  { id: "usr-006", name: "Sarah Levi", phone: "+1 (555) 666-7777", ext: "", dept: "Support", role: "user", email: "sarah@unisip.com", client: "", status: "online", vmEmail: true, canCallOut: false },
];

const CALLS = [
  { time: "2:31 PM", dir: "in", from: "+1 (718) 555-0142", ext: "101", user: "Moshe", path: "Main → Orders → Catskills", dur: "3:22", status: "completed" },
  { time: "2:18 PM", dir: "out", from: "+1 (347) 555-0198", ext: "100", user: "Carol", path: "—", dur: "1:47", status: "completed" },
  { time: "2:05 PM", dir: "in", from: "+1 (212) 555-0367", ext: "102", user: "Chaim", path: "Main → Orders → National", dur: "—", status: "missed" },
  { time: "1:52 PM", dir: "in", from: "+1 (917) 555-0821", ext: "IVR", user: "—", path: "Main → Orders → VM", dur: "0:45", status: "voicemail" },
  { time: "1:40 PM", dir: "int", from: "100 → 101", ext: "100", user: "Carol", path: "—", dur: "0:38", status: "completed" },
  { time: "1:15 PM", dir: "in", from: "+1 (845) 555-0444", ext: "101", user: "Moshe", path: "Main → Orders → Catskills", dur: "5:12", status: "completed" },
  { time: "12:48 PM", dir: "out", from: "+1 (516) 555-0933", ext: "102", user: "Chaim", path: "—", dur: "2:08", status: "completed" },
  { time: "12:30 PM", dir: "in", from: "+1 (646) 555-0177", ext: "201", user: "David", path: "Main → AR", dur: "—", status: "missed" },
];

const VMS = [
  { id: "v1", caller: "+1 (917) 555-0821", path: "Main → Orders → Catskills → VM", dur: "0:45", time: "1:52 PM", day: "Today", unread: true },
  { id: "v2", caller: "+1 (845) 555-0312", path: "Main → Shipping → VM", dur: "1:12", time: "11:30 AM", day: "Today", unread: true },
  { id: "v3", caller: "+1 (212) 555-0903", path: "Main → AP → VM", dur: "0:32", time: "9:15 AM", day: "Today", unread: true },
  { id: "v4", caller: "+1 (718) 555-0476", path: "Main → Orders → National → VM", dur: "0:28", time: "4:45 PM", day: "Yesterday", unread: false },
  { id: "v5", caller: "+1 (347) 555-0188", path: "Main → Support → Billing → VM", dur: "0:55", time: "2:10 PM", day: "Yesterday", unread: false },
];

/* ─── styles ─── */
const C = {
  bg: "#F8F8F6", card: "#FFF", side: "#111114", sideHover: "#1E1E24", sideActive: "#2A2A32",
  text: "#111114", sub: "#71717A", accent: "#2563EB", accentLt: "#EFF6FF", accentBd: "#DBEAFE",
  green: "#16A34A", greenBg: "#F0FDF4", greenBd: "#BBF7D0",
  amber: "#D97706", amberBg: "#FFFBEB", amberBd: "#FDE68A",
  red: "#DC2626", redBg: "#FEF2F2", redBd: "#FECACA",
  purple: "#7C3AED",
  border: "#E4E4E7", borderLt: "#F4F4F5",
};
const S = {
  input: { padding: "6px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", outline: "none", background: "#FFF" },
  select: { padding: "5px 8px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 11, fontFamily: "inherit", background: "#FFF", outline: "none" },
  btnSm: { padding: "4px 10px", fontSize: 11, border: `1px solid ${C.border}`, borderRadius: 6, background: "#FFF", cursor: "pointer", fontFamily: "inherit", color: C.text },
  btnTiny: { padding: "2px 6px", fontSize: 10, border: `1px solid ${C.border}`, borderRadius: 4, background: "#FFF", cursor: "pointer", fontFamily: "inherit", color: "#999", lineHeight: 1 },
  btn: { padding: "8px 14px", fontSize: 13, fontWeight: 500, border: `1px solid ${C.border}`, borderRadius: 8, background: "#FFF", cursor: "pointer", fontFamily: "inherit" },
  btnP: { padding: "8px 14px", fontSize: 13, fontWeight: 500, border: "none", borderRadius: 8, background: C.accent, color: "#FFF", cursor: "pointer", fontFamily: "inherit" },
  textarea: { width: "100%", padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical", minHeight: 36, outline: "none" },
  label: { display: "block", fontSize: 11, fontWeight: 500, color: C.sub, marginBottom: 3 },
  tag: (bg, col, bd) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: bg, color: col, border: `1px solid ${bd}` }),
};

/* ─── tiny components ─── */
const Tag = ({ children, color = "blue" }) => {
  const m = { blue: [C.accentLt, C.accent, C.accentBd], green: [C.greenBg, C.green, C.greenBd], amber: [C.amberBg, C.amber, C.amberBd], red: [C.redBg, C.red, C.redBd], gray: ["#F4F4F5","#71717A","#E4E4E7"] };
  const [bg, fg, bd] = m[color] || m.blue;
  return <span style={S.tag(bg, fg, bd)}>{children}</span>;
};
const Dot = ({ s }) => {
  const col = s === "online" ? C.green : s === "oncall" ? C.amber : "#CCC";
  return <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: col, marginRight: 5, verticalAlign: "middle", animation: s === "oncall" ? "pulse 1.2s infinite" : "none" }} />;
};
const StatusLabel = ({ s }) => s === "online" ? <Tag color="green">Online</Tag> : s === "oncall" ? <Tag color="amber">On call</Tag> : <Tag color="gray">Offline</Tag>;

/* ─── Fallback Chain ─── */
function FallbackChain({ fallbacks, onChange }) {
  const add = () => onChange([...fallbacks, { type: "Voicemail", target: "" }]);
  const rm = (i) => onChange(fallbacks.filter((_, j) => j !== i));
  const up = (i, k, v) => { const n = [...fallbacks]; n[i] = { ...n[i], [k]: v }; onChange(n); };
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: C.sub, fontWeight: 600, marginBottom: 4 }}>Fallback chain (no answer)</div>
      {fallbacks.map((fb, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: "#AAA", minWidth: 14 }}>{i + 1}.</span>
          <select value={fb.type} onChange={e => up(i, "type", e.target.value)} style={S.select}>
            <option>Forward to number</option><option>Voicemail</option><option>Return to menu</option><option>Ring extension</option>
          </select>
          {(fb.type === "Forward to number" || fb.type === "Ring extension") && (
            <input value={fb.target} onChange={e => up(i, "target", e.target.value)} placeholder={fb.type === "Forward to number" ? "+1..." : "ext"} style={{ ...S.input, width: fb.type === "Forward to number" ? 130 : 50 }} />
          )}
          <button onClick={() => rm(i)} style={S.btnTiny}>✕</button>
        </div>
      ))}
      <button onClick={add} style={S.btnSm}>+ fallback step</button>
    </div>
  );
}

/* ─── Time Rule Editor ─── */
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_PRESETS = [
  { label: "After hours (weekdays)", days: [1,2,3,4,5], allDay: false, startTime: "17:00", endTime: "09:00" },
  { label: "Fri early close", days: [5], allDay: false, startTime: "13:00", endTime: "23:59" },
  { label: "Weekends", days: [0,6], allDay: true, startTime: "", endTime: "" },
  { label: "Business hours", days: [1,2,3,4,5], allDay: false, startTime: "09:00", endTime: "17:00" },
];

function TimeRuleEditor({ rules, onChange }) {
  const add = (preset) => onChange([...rules, {
    id: uid(), label: preset.label, days: [...preset.days], allDay: preset.allDay,
    startTime: preset.startTime, endTime: preset.endTime,
    action: "Forward to number", target: "", targets: [],
  }]);
  const addCustom = () => onChange([...rules, {
    id: uid(), label: "New rule", days: [1,2,3,4,5], allDay: false,
    startTime: "09:00", endTime: "17:00", action: "Forward to number", target: "", targets: [],
  }]);
  const rm = (i) => onChange(rules.filter((_, j) => j !== i));
  const up = (i, k, v) => { const n = [...rules]; n[i] = { ...n[i], [k]: v }; onChange(n); };
  const toggleDay = (i, d) => {
    const r = rules[i];
    const days = r.days.includes(d) ? r.days.filter(x => x !== d) : [...r.days, d].sort((a, b) => a - b);
    up(i, 'days', days);
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: C.sub, fontWeight: 600, marginBottom: 4 }}>Time-based routing overrides</div>
      {rules.length === 0 && (
        <div style={{ fontSize: 11, color: "#BBB", fontStyle: "italic", marginBottom: 6 }}>No time rules — routing runs 24/7 the same way.</div>
      )}
      {rules.map((rule, i) => (
        <div key={rule.id} style={{ border: `1px solid ${C.amberBd}`, borderRadius: 8, padding: "8px 10px", marginBottom: 6, background: C.amberBg }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
            <input value={rule.label} onChange={e => up(i, 'label', e.target.value)} placeholder="Rule name…" style={{ ...S.input, flex: 1, fontSize: 11, fontWeight: 600 }} />
            <button onClick={() => rm(i)} style={{ ...S.btnTiny, color: C.red }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 3, marginBottom: 6, flexWrap: "wrap" }}>
            {DAYS_SHORT.map((d, di) => (
              <button key={di} onClick={() => toggleDay(i, di)} style={{ padding: "2px 7px", fontSize: 10, fontWeight: 600, border: `1px solid ${rule.days.includes(di) ? C.amber : C.border}`, borderRadius: 5, background: rule.days.includes(di) ? C.amber : "#FFF", color: rule.days.includes(di) ? "#FFF" : C.sub, cursor: "pointer", fontFamily: "inherit" }}>{d}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer" }}>
              <input type="checkbox" checked={rule.allDay || false} onChange={e => up(i, 'allDay', e.target.checked)} /> All day
            </label>
            {!rule.allDay && <>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 10, color: C.sub }}>From</span>
                <input type="time" value={rule.startTime || ""} onChange={e => up(i, 'startTime', e.target.value)} style={{ ...S.input, fontSize: 11, width: 90 }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 10, color: C.sub }}>to</span>
                <input type="time" value={rule.endTime || ""} onChange={e => up(i, 'endTime', e.target.value)} style={{ ...S.input, fontSize: 11, width: 90 }} />
              </div>
            </>}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: C.sub, fontWeight: 600 }}>→ Route to:</span>
            <select value={rule.action} onChange={e => up(i, 'action', e.target.value)} style={S.select}>
              <option>Forward to number</option><option>Voicemail</option><option>Ring extension</option><option>Ring group</option>
            </select>
            {(rule.action === "Forward to number" || rule.action === "Ring extension") && (
              <input value={rule.target || ""} onChange={e => up(i, 'target', e.target.value)} placeholder={rule.action === "Forward to number" ? "+1..." : "ext"} style={{ ...S.input, width: rule.action === "Forward to number" ? 130 : 56, fontSize: 11, fontFamily: "monospace" }} />
            )}
            {rule.action === "Ring group" && (
              <input value={(rule.targets || []).join(", ")} onChange={e => up(i, 'targets', e.target.value.split(",").map(s => s.trim()).filter(Boolean))} placeholder="101, +1555..." style={{ ...S.input, width: 140, fontSize: 11, fontFamily: "monospace" }} />
            )}
          </div>
        </div>
      ))}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10, color: C.sub }}>Quick add:</span>
        {TIME_PRESETS.map((p, pi) => (
          <button key={pi} onClick={() => add(p)} style={{ ...S.btnSm, fontSize: 10, borderColor: C.amberBd, color: C.amber }}>+ {p.label}</button>
        ))}
        <button onClick={addCustom} style={{ ...S.btnSm, fontSize: 10 }}>+ Custom rule</button>
      </div>
    </div>
  );
}

/* ─── Option Editor (recursive) ─── */
function OptionEditor({ option, index, depth, onChange, onRemove, onMoveUp, onMoveDown, isFirst, isLast, onPreview }) {
  const [open, setOpen] = useState(false);
  const set = (k, v) => onChange({ ...option, [k]: v });
  const bc = { "Extension (SIP)": C.green, "Ring group": C.accent, "Forward to number": C.amber, Voicemail: C.red, Submenu: C.purple, Announcement: "#999" }[option.action] || "#CCC";
  const addChild = () => set("children", [...option.children, defaultOption()]);
  const updChild = (i, c) => { const a = [...option.children]; a[i] = c; set("children", a); };
  const rmChild = (i) => set("children", option.children.filter((_, j) => j !== i));
  const mvChild = (i, d) => { const a = [...option.children]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; set("children", a); };
  const hasFB = ["Extension (SIP)", "Ring group", "Forward to number"].includes(option.action);
  const isSub = option.action === "Submenu";
  const isVM = option.action === "Voicemail";
  const isAnn = option.action === "Announcement";
  const isRG = option.action === "Ring group";

  return (
    <div style={{ borderLeft: `3px solid ${bc}`, borderRadius: "0 8px 8px 0", marginBottom: 6, background: "#FFF", border: `1px solid ${C.border}`, borderLeftWidth: 3, borderLeftColor: bc, overflow: "hidden", fontSize: 13 }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 12px", cursor: "pointer", background: open ? C.bg : "transparent" }}>
        <span style={{ background: C.accent, color: "#FFF", width: 20, height: 20, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{index + 1}</span>
        <input value={option.label} onChange={e => set("label", e.target.value)} onClick={e => e.stopPropagation()} placeholder="Name..." style={{ border: "none", fontSize: 13, fontWeight: 600, background: "transparent", flex: 1, outline: "none", fontFamily: "inherit", minWidth: 60 }} />
        <select value={option.action} onChange={e => { e.stopPropagation(); set("action", e.target.value); }} onClick={e => e.stopPropagation()} style={{ ...S.select, fontWeight: 500 }}>
          {ACTIONS.map(a => <option key={a}>{a}</option>)}
        </select>
        {option.action === "Extension (SIP)" && <input value={option.target} onChange={e => { e.stopPropagation(); set("target", e.target.value); }} onClick={e => e.stopPropagation()} placeholder="ext" style={{ ...S.input, width: 44, fontFamily: "monospace", fontSize: 12 }} />}
        {isRG && <input value={option.targets.join(", ")} onChange={e => { e.stopPropagation(); set("targets", e.target.value.split(",").map(s => s.trim()).filter(Boolean)); }} onClick={e => e.stopPropagation()} placeholder="101, +1555..." style={{ ...S.input, width: 110, fontFamily: "monospace", fontSize: 11 }} />}
        {option.action === "Forward to number" && <input value={option.target} onChange={e => { e.stopPropagation(); set("target", e.target.value); }} onClick={e => e.stopPropagation()} placeholder="+1..." style={{ ...S.input, width: 120, fontFamily: "monospace", fontSize: 11 }} />}
        <div style={{ display: "flex", gap: 2 }}>
          {!isFirst && <button onClick={e => { e.stopPropagation(); onMoveUp(); }} style={S.btnTiny}>↑</button>}
          {!isLast && <button onClick={e => { e.stopPropagation(); onMoveDown(); }} style={S.btnTiny}>↓</button>}
          <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{ ...S.btnTiny, color: C.red }}>✕</button>
        </div>
        <span style={{ fontSize: 14, color: "#BBB", transform: open ? "rotate(90deg)" : "none", transition: "0.15s" }}>›</span>
      </div>
      {open && (
        <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.borderLt}` }}>
          {/* Ring group explainer */}
          {isRG && (
            <div style={{ background: C.accentLt, border: `1px solid ${C.accentBd}`, borderRadius: 8, padding: "8px 10px", marginBottom: 8, fontSize: 11, color: C.accent }}>
              <strong>Ring group:</strong> All listed extensions and phone numbers ring simultaneously. First to answer gets the call. Mix SIP extensions (e.g. 101) and phone numbers (e.g. +1 555...) in one group.
            </div>
          )}
          {isSub && <>
            <div style={{ marginBottom: 8 }}>
              <label style={S.label}>Sub-menu intro</label>
              <textarea value={option.submenuIntro} onChange={e => set("submenuIntro", e.target.value)} rows={1} style={S.textarea} />
              {onPreview && option.submenuIntro && <button onClick={() => onPreview(option.submenuIntro + " " + generatePrompt(option.children))} style={{ ...S.btnSm, marginTop: 4, fontSize: 10 }}>▶ Preview this sub-menu</button>}
            </div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: C.sub, fontWeight: 600, marginBottom: 6 }}>Sub-options</div>
            {option.children.map((c, ci) => <OptionEditor key={c.id} option={c} index={ci} depth={depth + 1} onChange={x => updChild(ci, x)} onRemove={() => rmChild(ci)} onMoveUp={() => mvChild(ci, -1)} onMoveDown={() => mvChild(ci, 1)} isFirst={ci === 0} isLast={ci === option.children.length - 1} onPreview={onPreview} />)}
            <button onClick={addChild} style={{ ...S.btnSm, marginBottom: 8, marginTop: 2 }}>+ sub-option</button>
            {option.children.length > 0 && <div style={{ background: C.greenBg, border: `1px solid ${C.greenBd}`, borderRadius: 8, padding: "6px 10px", fontSize: 11, color: C.green, marginBottom: 8 }}><strong>Auto:</strong> "{generatePrompt(option.children)}"</div>}
          </>}
          {(isVM || isSub) && <div style={{ marginBottom: 8 }}>
            <label style={S.label}>{isSub ? "Shared voicemail greeting" : "Voicemail greeting"}</label>
            <textarea value={option.vmGreeting} onChange={e => set("vmGreeting", e.target.value)} rows={2} style={S.textarea} />
            {onPreview && option.vmGreeting && <button onClick={() => onPreview(option.vmGreeting)} style={{ ...S.btnSm, marginTop: 4, fontSize: 10 }}>▶ Preview voicemail greeting</button>}
          </div>}
          {isAnn && <div style={{ marginBottom: 8 }}>
            <label style={S.label}>Announcement text</label>
            <textarea value={option.announcement} onChange={e => set("announcement", e.target.value)} rows={2} style={S.textarea} />
            {onPreview && option.announcement && <button onClick={() => onPreview(option.announcement)} style={{ ...S.btnSm, marginTop: 4, fontSize: 10 }}>▶ Preview announcement</button>}
          </div>}
          {hasFB && <TimeRuleEditor rules={option.timeRules || []} onChange={r => set("timeRules", r)} />}
          {hasFB && <FallbackChain fallbacks={option.fallbacks} onChange={f => set("fallbacks", f)} />}
          {(hasFB) && <div style={{ background: C.accentLt, border: `1px solid ${C.accentBd}`, borderRadius: 8, padding: "8px 10px", marginTop: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.accent, marginBottom: 3 }}>WHISPER</div>
            <input value={option.whisper} onChange={e => set("whisper", e.target.value)} placeholder="e.g. Incoming sales call" style={{ ...S.input, width: "100%", fontSize: 12 }} />
            <div style={{ fontSize: 9, color: C.sub, marginTop: 2 }}>Agent hears this before connecting. Caller hears ringing.</div>
          </div>}
        </div>
      )}
    </div>
  );
}

/* ─── Page: IVR Editor ─── */
function IVRPage() {
  const [greetings, setGreetings] = useState(GREETINGS);
  const [activeGreet, setActiveGreet] = useState("main");
  const [options, setOptions] = useState(MENU_OPTIONS);
  const [voice, setVoice] = useState("Alloy");
  const [opExt, setOpExt] = useState("100");
  const [onHold, setOnHold] = useState("Thank you for calling UniSip. While you hold, grab your favorite UniSip drink so you feel refreshed when we get back to your call.");
  const [showPreview, setShowPreview] = useState(false);
  const [ttsState, setTtsState] = useState(null); // null | "generating" | "ready" | "playing"
  const [ttsText, setTtsText] = useState("");
  const [ttsProgress, setTtsProgress] = useState(0);

  const simulateTTS = (text) => {
    setTtsText(text.slice(0, 200) + (text.length > 200 ? "..." : ""));
    setTtsState("generating");
    setTtsProgress(0);
    const genInterval = setInterval(() => {
      setTtsProgress(p => {
        if (p >= 100) { clearInterval(genInterval); setTtsState("ready"); return 100; }
        return p + Math.random() * 15 + 5;
      });
    }, 200);
  };

  const simulatePlay = () => {
    setTtsState("playing");
    setTtsProgress(0);
    const playInterval = setInterval(() => {
      setTtsProgress(p => {
        if (p >= 100) { clearInterval(playInterval); setTtsState("ready"); return 100; }
        return p + 2;
      });
    }, 100);
  };

  const g = greetings.find(x => x.id === activeGreet);
  const setG = (k, v) => setGreetings(greetings.map(x => x.id === activeGreet ? { ...x, [k]: v } : x));
  const setGSched = (k, v) => setG("schedule", { ...(g.schedule || { type: "custom", start: "", end: "", startNow: false }), [k]: v });
  const addGreeting = () => { const id = uid(); setGreetings([...greetings, { id, label: "Custom", text: "", schedule: { type: "custom", start: "", end: "", startNow: false } }]); setActiveGreet(id); };
  const rmGreeting = (id) => { if (greetings.length < 2) return; setGreetings(greetings.filter(x => x.id !== id)); if (activeGreet === id) setActiveGreet(greetings[0].id); };

  const setOpt = (i, o) => { const a = [...options]; a[i] = o; setOptions(a); };
  const rmOpt = (i) => setOptions(options.filter((_, j) => j !== i));
  const addOpt = () => setOptions([...options, defaultOption()]);
  const mvOpt = (i, d) => { const a = [...options]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setOptions(a); };

  const fullPrompt = `${g?.text || ""}\n\n${generatePrompt(options)}. Or stay on the line for the operator.`;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div><h2 style={{ fontSize: 17, fontWeight: 600 }}>IVR Menu Editor</h2><p style={{ fontSize: 11, color: C.sub }}>Greeting tabs control what callers hear first. Menu options are shared.</p></div>
        <div style={{ display: "flex", gap: 6 }}><button onClick={() => setShowPreview(!showPreview)} style={S.btn}>{showPreview ? "Hide" : "Show"} preview</button><button onClick={() => simulateTTS(fullPrompt)} style={S.btnP}>Save & generate audio</button></div>
      </div>

      {/* TTS generation / playback panel */}
      {ttsState && (
        <div style={{ background: C.card, border: `1px solid ${ttsState === "playing" ? C.accent : ttsState === "ready" ? C.greenBd : C.amberBd}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: ttsState === "generating" ? C.amber : ttsState === "playing" ? C.accent : C.green }}>
              {ttsState === "generating" ? "⏳ Generating TTS audio..." : ttsState === "playing" ? "🔊 Playing preview..." : "✅ Audio ready"}
            </div>
            <div style={{ fontSize: 10, color: C.sub }}>Voice: {voice}</div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              {ttsState === "ready" && <button onClick={simulatePlay} style={{ ...S.btnSm, background: C.accent, color: "#FFF", borderColor: C.accent }}>▶ Listen</button>}
              {ttsState !== "generating" && <button onClick={() => setTtsState(null)} style={S.btnSm}>Dismiss</button>}
            </div>
          </div>
          <div style={{ height: 6, background: C.borderLt, borderRadius: 3, overflow: "hidden", marginBottom: 6 }}>
            <div style={{ height: "100%", width: `${Math.min(ttsProgress, 100)}%`, background: ttsState === "generating" ? C.amber : C.accent, borderRadius: 3, transition: "width 0.2s" }} />
          </div>
          <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.4 }}>{ttsText}</div>
        </div>
      )}

      {/* Greeting tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${C.border}`, marginBottom: 12, flexWrap: "wrap" }}>
        {greetings.map(gr => (
          <div key={gr.id} style={{ display: "flex", alignItems: "center" }}>
            <button onClick={() => setActiveGreet(gr.id)} style={{ padding: "8px 14px", fontSize: 12, fontWeight: 500, color: activeGreet === gr.id ? C.accent : C.sub, border: "none", background: "none", cursor: "pointer", borderBottom: activeGreet === gr.id ? `2px solid ${C.accent}` : "2px solid transparent", fontFamily: "inherit" }}>{gr.label}</button>
            {gr.id !== "main" && <button onClick={() => rmGreeting(gr.id)} style={{ ...S.btnTiny, border: "none", marginRight: 4 }}>✕</button>}
          </div>
        ))}
        <button onClick={addGreeting} style={{ ...S.btnTiny, border: "none", padding: "8px 10px", color: C.accent }}>+ Add greeting</button>
      </div>

      {/* Active greeting editor */}
      {g && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 8, alignItems: "center" }}>
            <div style={{ flex: 1 }}><label style={S.label}>Tab name</label><input value={g.label} onChange={e => setG("label", e.target.value)} style={{ ...S.input, width: "100%" }} /></div>
            <div style={{ flex: 0 }}><label style={S.label}>Voice</label><select value={voice} onChange={e => setVoice(e.target.value)} style={S.select}>{["Alloy","Nova","Shimmer","Echo","Onyx","Fable"].map(v => <option key={v}>{v}</option>)}</select></div>
            <div style={{ flex: 0 }}><label style={S.label}>Operator</label><input value={opExt} onChange={e => setOpExt(e.target.value)} style={{ ...S.input, width: 44, fontFamily: "monospace" }} /></div>
          </div>
          <label style={S.label}>Greeting text (system appends "press X for Y" from options)</label>
          <textarea value={g.text} onChange={e => setG("text", e.target.value)} rows={2} style={S.textarea} />

          {/* Schedule */}
          {g.id !== "main" && (
            <div style={{ marginTop: 10, background: C.accentLt, border: `1px solid ${C.accentBd}`, borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.accent, marginBottom: 6 }}>SCHEDULE</div>
              {g.schedule?.type === "auto" ? (
                <div style={{ fontSize: 12, color: C.sub }}>Rule: {g.schedule.rule} (automatic)</div>
              ) : (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                    <input type="checkbox" checked={g.schedule?.startNow || false} onChange={e => setGSched("startNow", e.target.checked)} /> Activate now
                  </label>
                  {!g.schedule?.startNow && <div><label style={{ fontSize: 10, color: C.sub }}>Start</label><input type="datetime-local" value={g.schedule?.start || ""} onChange={e => setGSched("start", e.target.value)} style={{ ...S.input, fontSize: 11 }} /></div>}
                  <div><label style={{ fontSize: 10, color: C.sub }}>Expires</label><input type="datetime-local" value={g.schedule?.end || ""} onChange={e => setGSched("end", e.target.value)} style={{ ...S.input, fontSize: 11 }} /></div>
                  <div style={{ fontSize: 10, color: C.sub }}>When expired, reverts to main greeting</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showPreview && <div style={{ background: C.greenBg, border: `1px solid ${C.greenBd}`, borderRadius: 10, padding: 14, marginBottom: 14, fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", color: C.text }}><div style={{ fontSize: 10, fontWeight: 600, color: C.green, marginBottom: 4 }}>FULL PROMPT (sent to TTS)</div>{fullPrompt}</div>}

      {/* On hold (separate setting) */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}><span style={{ fontSize: 13, fontWeight: 600 }}>🎵 On hold message</span><span style={{ fontSize: 10, color: C.sub }}>Separate from IVR — plays when caller is on hold</span></div>
        <textarea value={onHold} onChange={e => setOnHold(e.target.value)} rows={2} style={S.textarea} />
      </div>

      {/* Menu options */}
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1.2, color: C.sub, fontWeight: 600, marginBottom: 6 }}>Menu options (shared across all greetings, auto-numbered)</div>
      {options.map((o, i) => <OptionEditor key={o.id} option={o} index={i} depth={0} onChange={x => setOpt(i, x)} onRemove={() => rmOpt(i)} onMoveUp={() => mvOpt(i, -1)} onMoveDown={() => mvOpt(i, 1)} isFirst={i === 0} isLast={i === options.length - 1} onPreview={simulateTTS} />)}
      <div style={{ borderLeft: "3px solid #D4D4D8", borderRadius: "0 8px 8px 0", padding: "8px 12px", background: C.card, border: `1px solid ${C.border}`, borderLeftWidth: 3, borderLeftColor: "#D4D4D8", opacity: 0.5, marginBottom: 8, fontSize: 12, color: C.sub }}>⌛ Stay on line / timeout → Ext {opExt} → voicemail</div>
      <button onClick={addOpt} style={S.btnP}>+ Add menu option</button>
    </div>
  );
}

/* ─── Page: Call Logs ─── */
function CallsPage() {
  return <div>
    <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 12 }}>Call logs</h2>
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr style={{ background: C.bg }}>{["Time","Dir","From / To","Ext","IVR path","Dur","Status"].map(h => <th key={h} style={{ textAlign: "left", padding: "8px 14px", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.8, color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
        <tbody>{CALLS.map((c, i) => <tr key={i}><td style={td}>{c.time}</td><td style={td}><Tag color={c.dir === "in" ? "blue" : c.dir === "out" ? "amber" : "gray"}>{c.dir === "in" ? "Inbound" : c.dir === "out" ? "Outbound" : "Internal"}</Tag></td><td style={{ ...td, fontFamily: "monospace", fontSize: 11 }}>{c.from}</td><td style={{ ...td, fontFamily: "monospace" }}>{c.ext}</td><td style={td}>{c.path}</td><td style={{ ...td, fontFamily: "monospace" }}>{c.dur}</td><td style={td}><Tag color={c.status === "completed" ? "green" : c.status === "missed" ? "red" : "amber"}>{c.status}</Tag></td></tr>)}</tbody>
      </table>
    </div>
  </div>;
}
const td = { padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, verticalAlign: "middle" };

/* ─── Page: Voicemail ─── */
function VoicemailPage() {
  const [vms, setVms] = useState(VMS);
  const [playing, setPlaying] = useState(null);
  const markRead = (id) => setVms(vms.map(v => v.id === id ? { ...v, unread: false } : v));
  return <div>
    <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 12 }}>Voicemail</h2>
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      {vms.map(v => (
        <div key={v.id}>
          <div onClick={() => { setPlaying(playing === v.id ? null : v.id); markRead(v.id); }} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", cursor: "pointer", background: v.unread ? C.accentLt : "transparent", borderBottom: `1px solid ${C.borderLt}` }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", background: v.unread ? C.accent : C.bg, border: `1px solid ${v.unread ? C.accent : C.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill={v.unread ? "#FFF" : "#999"}><polygon points="5 3 19 12 5 21" /></svg>
            </div>
            <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: v.unread ? 600 : 400 }}>{v.caller}</div><div style={{ fontSize: 11, color: C.sub }}>{v.path}</div></div>
            <div style={{ fontFamily: "monospace", fontSize: 12, color: C.sub }}>{v.dur}</div>
            <div style={{ fontSize: 11, color: C.sub, textAlign: "right", minWidth: 60 }}>{v.time}<br /><span style={{ fontSize: 10 }}>{v.day}</span></div>
          </div>
          {playing === v.id && (
            <div style={{ padding: "10px 16px", background: C.bg, borderBottom: `1px solid ${C.borderLt}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button style={{ width: 32, height: 32, borderRadius: "50%", background: C.accent, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="12" height="12" viewBox="0 0 24 24" fill="#FFF"><polygon points="5 3 19 12 5 21" /></svg></button>
                <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 3, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: "35%", background: C.accent, borderRadius: 3 }} /></div>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: C.sub }}>0:15 / {v.dur}</span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  </div>;
}

/* ─── Page: Extensions (admin) ─── */
function ExtensionsPage() {
  const [users, setUsers] = useState(USERS);
  const upd = (i, k, v) => { const u = [...users]; u[i] = { ...u[i], [k]: v }; setUsers(u); };
  const addUser = () => setUsers([...users, { id: uid(), name: "", phone: "", ext: "", dept: "", role: "user", email: "", client: "", status: "offline", vmEmail: true, canCallOut: false }]);
  const rmUser = (i) => setUsers(users.filter((_, j) => j !== i));
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><h2 style={{ fontSize: 17, fontWeight: 600 }}>Manage users & extensions</h2><button onClick={addUser} style={S.btnP}>+ Add user</button></div>
    <div style={{ fontSize: 11, color: C.sub, marginBottom: 12, lineHeight: 1.5 }}>Every user has a phone number (identity + forwarding). Extension is optional — only for users with a SIP client (desk phone / app). Users without an extension receive calls via forwarding only.</div>
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {users.map((u, i) => (
        <div key={u.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          {/* Header row */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.borderLt}` }}>
            <Dot s={u.status} />
            <input value={u.name} onChange={e => upd(i, "name", e.target.value)} placeholder="Name" style={{ ...S.input, border: "none", background: "transparent", fontWeight: 600, fontSize: 13, flex: 1, padding: 0 }} />
            <Tag color={u.role === "admin" ? "blue" : "gray"}>{u.role}</Tag>
            <select value={u.role} onChange={e => upd(i, "role", e.target.value)} style={{ ...S.select, fontSize: 10 }}><option value="user">User</option><option value="admin">Admin</option></select>
            <button onClick={() => rmUser(i)} style={{ ...S.btnTiny, color: C.red }}>Remove</button>
          </div>
          {/* Fields */}
          <div style={{ padding: "10px 14px", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end" }}>
            {/* Phone (always required) */}
            <div style={{ minWidth: 160 }}>
              <label style={S.label}>Phone number (required)</label>
              <input value={u.phone} onChange={e => upd(i, "phone", e.target.value)} placeholder="+1 (555) ..." style={{ ...S.input, fontFamily: "monospace", fontSize: 12, width: "100%" }} />
              <div style={{ fontSize: 9, color: C.sub, marginTop: 2 }}>Used for OTP login + forwarding</div>
            </div>
            {/* Extension (optional) */}
            <div style={{ minWidth: 140 }}>
              <label style={S.label}>Extension (optional)</label>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input value={u.ext} onChange={e => upd(i, "ext", e.target.value)} placeholder="—" style={{ ...S.input, fontFamily: "monospace", fontSize: 13, fontWeight: 600, width: 56 }} />
                {u.ext ? <Tag color="green">SIP</Tag> : <Tag color="gray">Forward only</Tag>}
              </div>
              <div style={{ fontSize: 9, color: C.sub, marginTop: 2 }}>{u.ext ? "Rings via PBX (desk phone / app)" : "No SIP client — calls forwarded to phone"}</div>
            </div>
            {/* Client (only if ext) */}
            {u.ext && (
              <div style={{ minWidth: 120 }}>
                <label style={S.label}>SIP client</label>
                <select value={u.client} onChange={e => upd(i, "client", e.target.value)} style={{ ...S.select, width: "100%" }}>
                  <option value="">Select...</option><option>MicroSIP</option><option>Zoiper</option><option>Zoiper iOS</option><option>Zoiper Android</option><option>Linphone</option><option>Other</option>
                </select>
              </div>
            )}
            {/* Can call out (only if ext) */}
            {u.ext && (
              <div>
                <label style={S.label}>Outbound calls</label>
                <span onClick={() => upd(i, "canCallOut", !u.canCallOut)} style={{ ...S.tag(u.canCallOut ? C.greenBg : C.redBg, u.canCallOut ? C.green : C.red, u.canCallOut ? C.greenBd : C.redBd), cursor: "pointer", fontSize: 11 }}>{u.canCallOut ? "Enabled" : "Disabled"}</span>
                <div style={{ fontSize: 9, color: C.sub, marginTop: 2 }}>Can dial out via SIP</div>
              </div>
            )}
            {/* Email */}
            <div style={{ minWidth: 160 }}>
              <label style={S.label}>Email</label>
              <input value={u.email} onChange={e => upd(i, "email", e.target.value)} placeholder="user@company.com" style={{ ...S.input, fontSize: 11, width: "100%" }} />
            </div>
            {/* VM to email */}
            <div>
              <label style={S.label}>VM → Email</label>
              <span onClick={() => upd(i, "vmEmail", !u.vmEmail)} style={{ ...S.tag(u.vmEmail ? C.greenBg : C.redBg, u.vmEmail ? C.green : C.red, u.vmEmail ? C.greenBd : C.redBd), cursor: "pointer" }}>{u.vmEmail ? "On" : "Off"}</span>
            </div>
          </div>
          {/* Connection summary */}
          <div style={{ padding: "6px 14px 10px", fontSize: 11, color: C.sub }}>
            {u.ext && u.phone ? `Incoming → ring ext ${u.ext} (SIP) + forward to ${u.phone} simultaneously` :
             u.ext ? `Incoming → ring ext ${u.ext} (SIP only)` :
             u.phone ? `Incoming → forward to ${u.phone} directly (no PBX)` :
             "No routing configured"}
            {u.ext && u.canCallOut ? ` · Can dial out via ext ${u.ext}` : ""}
          </div>
        </div>
      ))}
    </div>
  </div>;
}

/* ─── Page: Costs ─── */
function CostsPage() {
  return <div>
    <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 12 }}>Cost dashboard <span style={{ fontSize: 12, fontWeight: 400, color: C.sub }}>— May 2026</span></h2>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
      {[["Total", "$34.72", "↓ $2.10"], ["Twilio", "$25.73", "1,842 min"], ["Azure", "$2.18", "Blob + Container"], ["OpenAI", "$0.33", "TTS + Whisper"]].map(([l, v, c], i) => (
        <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}><div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.8, color: C.sub, fontWeight: 500 }}>{l}</div><div style={{ fontSize: 24, fontWeight: 600, letterSpacing: -0.5, marginTop: 2 }}>{v}</div><div style={{ fontSize: 11, color: i === 0 ? C.green : C.sub, marginTop: 2 }}>{c}</div></div>
      ))}
    </div>
    {[
      { title: "Twilio", src: "Usage Records API", rows: [["Phone numbers","2 numbers","$1.00/mo","$2.00"],["Inbound","1,247 min","$0.0085/min","$10.60"],["Outbound","595 min","$0.014/min","$8.33"],["SIP internal","312 min","$0.004/min","$1.25"],["Recordings","89","$0.0025/min","$0.30"],["Verify (OTP)","65","$0.05/ea","$3.25"],["SendGrid","89 emails","Free tier","$0.00"]], total: "$25.73" },
      { title: "Azure", src: "Cost Management API", rows: [["Blob Storage","2.4 GB · 12K ops","Pay-as-you-go","$2.18"],["Container App","4,200 vCPU-sec","Free tier","$0.00"],["Static Web Apps","—","Free tier","$0.00"]], total: "$2.18" },
      { title: "OpenAI", src: "Usage log", rows: [["TTS (greetings)","4,520 chars","$15/1M chars","$0.07"],["Whisper (VM)","44 min","$0.006/min","$0.26"]], total: "$0.33" },
    ].map(sec => (
      <div key={sec.title} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}` }}><span style={{ fontSize: 13, fontWeight: 600 }}>{sec.title}</span><span style={{ fontSize: 10, color: C.sub }}>{sec.src}</span></div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr style={{ background: C.bg }}>{["Item","Usage","Rate","Cost"].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 14px", fontSize: 10, textTransform: "uppercase", color: C.sub, fontWeight: 600 }}>{h}</th>)}</tr></thead>
          <tbody>
            {sec.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ ...td, padding: "8px 14px", fontFamily: j > 0 ? "monospace" : "inherit", fontSize: j > 0 ? 11 : 12, fontWeight: j === 3 ? 600 : 400, color: c === "$0.00" ? C.green : C.text }}>{c}</td>)}</tr>)}
            <tr style={{ background: C.bg }}><td colSpan={3} style={{ ...td, padding: "8px 14px", fontWeight: 600 }}>Subtotal</td><td style={{ ...td, padding: "8px 14px", fontFamily: "monospace", fontWeight: 600, color: C.accent }}>{sec.total}</td></tr>
          </tbody>
        </table>
      </div>
    ))}
  </div>;
}

/* ─── Page: User Settings ─── */
function SettingsPage({ user }) {
  const [vmEmail, setVmEmail] = useState(true);
  const [vmTranscribe, setVmTranscribe] = useState(true);
  const [missedEmail, setMissedEmail] = useState(false);
  const Toggle = ({ on, set }) => <div onClick={() => set(!on)} style={{ width: 36, height: 20, background: on ? C.accent : "#D4D4D8", borderRadius: 10, cursor: "pointer", position: "relative", transition: "0.2s", flexShrink: 0 }}><div style={{ position: "absolute", top: 2, left: on ? 18 : 2, width: 16, height: 16, background: "#FFF", borderRadius: "50%", boxShadow: "0 1px 3px rgba(0,0,0,0.15)", transition: "0.2s" }} /></div>;
  const Row = ({ label, desc, children }) => <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: `1px solid ${C.borderLt}` }}><div><div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div><div style={{ fontSize: 11, color: C.sub, marginTop: 1 }}>{desc}</div></div>{children}</div>;
  return <div>
    <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 12 }}>Settings</h2>
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.borderLt}`, fontSize: 13, fontWeight: 600 }}>Your preferences</div>
      <Row label="Forward voicemails to email" desc={`MP3 + transcript sent to ${user.email}`}><Toggle on={vmEmail} set={setVmEmail} /></Row>
      <Row label="Include transcript" desc="Uses OpenAI Whisper to transcribe voicemail"><Toggle on={vmTranscribe} set={setVmTranscribe} /></Row>
      <Row label="Missed call email" desc="Notified when you miss an inbound call"><Toggle on={missedEmail} set={setMissedEmail} /></Row>
    </div>
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.borderLt}`, fontSize: 13, fontWeight: 600 }}>Your info</div>
      <Row label="Extension" desc={user.ext ? `Ext ${user.ext} — SIP registered` : "No extension — forward only"}>{user.ext ? <Tag color="green">{user.ext}</Tag> : <Tag color="gray">None</Tag>}</Row>
      <Row label="Phone number" desc="Your identity + forwarding number"><span style={{ fontFamily: "monospace", fontSize: 12 }}>{user.phone}</span></Row>
      <Row label="Routing" desc="How calls reach you"><span style={{ fontSize: 12 }}>{user.ext ? `Ring ext ${user.ext} + forward to ${user.phone}` : `Forward to ${user.phone}`}</span></Row>
      {user.ext && <Row label="Client" desc="SIP softphone"><span style={{ fontSize: 12 }}>{user.client}</span></Row>}
      {user.ext && <Row label="Outbound" desc="Can dial out via SIP">{user.canCallOut ? <Tag color="green">Enabled</Tag> : <Tag color="red">Disabled</Tag>}</Row>}
    </div>
  </div>;
}

/* ─── Login screen ─── */
function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState("ext");
  const [ext, setExt] = useState("100");
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState(1);
  const modes = [
    { id: "ext", label: "Extension" },
    { id: "phone", label: "Phone number" },
    { id: "admin", label: "Admin (Microsoft)" },
  ];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ background: "#FFF", borderRadius: 18, boxShadow: "0 8px 30px rgba(0,0,0,0.12)", padding: 36, width: 380, textAlign: "center" }}>
        {step === 1 ? <>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.5 }}>UniSip</div>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 22 }}>Phone system portal</div>
          <div style={{ display: "flex", border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
            {modes.map(m => (
              <button key={m.id} onClick={() => setMode(m.id)} style={{ flex: 1, padding: 8, fontSize: 11, fontWeight: 500, border: "none", cursor: "pointer", fontFamily: "inherit", background: mode === m.id ? C.accent : "#FFF", color: mode === m.id ? "#FFF" : C.sub }}>{m.label}</button>
            ))}
          </div>

          {mode === "ext" && <>
            <label style={{ ...S.label, textAlign: "left" }}>Extension number</label>
            <input value={ext} onChange={e => setExt(e.target.value)} placeholder="e.g. 100" style={{ ...S.input, width: "100%", padding: "10px 14px", fontSize: 14, marginBottom: 10 }} />
            <div style={{ background: C.accentLt, border: `1px solid ${C.accentBd}`, borderRadius: 8, padding: "8px 12px", marginBottom: 12, textAlign: "left" }}>
              <div style={{ fontSize: 11, color: C.accent, fontWeight: 500 }}>📞 Your extension will ring</div>
              <div style={{ fontSize: 10, color: C.sub, marginTop: 2 }}>System calls ext {ext || "..."} and reads a 6-digit code. Pick up and enter it below.</div>
            </div>
            <button onClick={() => setStep(2)} style={{ ...S.btnP, width: "100%", padding: 11 }}>Call my extension</button>
          </>}

          {mode === "phone" && <>
            <label style={{ ...S.label, textAlign: "left" }}>Your phone number</label>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 (555) 123-4567" style={{ ...S.input, width: "100%", padding: "10px 14px", fontSize: 14, marginBottom: 10 }} />
            <div style={{ background: C.amberBg, border: `1px solid ${C.amberBd}`, borderRadius: 8, padding: "8px 12px", marginBottom: 12, textAlign: "left" }}>
              <div style={{ fontSize: 11, color: C.amber, fontWeight: 500 }}>📱 SMS verification</div>
              <div style={{ fontSize: 10, color: C.sub, marginTop: 2 }}>A 6-digit code will be sent via text message to this number.</div>
            </div>
            <button onClick={() => setStep(2)} style={{ ...S.btnP, width: "100%", padding: 11 }}>Send SMS code</button>
          </>}

          {mode === "admin" && <>
            <div style={{ padding: "20px 0 10px" }}>
              <div style={{ width: 48, height: 48, borderRadius: 8, background: "#FFF", border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", fontSize: 20 }}>🏢</div>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Sign in with Microsoft Entra</div>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 16 }}>Uses your organization account. Popup closes automatically.</div>
            </div>
            <button onClick={() => onLogin(USERS[0])} style={{ ...S.btnP, width: "100%", padding: 11, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 21 21"><rect width="9" height="9" fill="#F25022"/><rect x="11" width="9" height="9" fill="#7FBA00"/><rect y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>
              Sign in with Microsoft
            </button>
            <div style={{ fontSize: 10, color: C.sub, marginTop: 12 }}>Delegated Entra token for storage access. No separate credentials.</div>
          </>}

        </> : <>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{mode === "ext" ? "Pick up your phone" : "Check your texts"}</div>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>{mode === "ext" ? `Calling ext ${ext} now...` : `SMS sent to ${phone || "+1 (555) •••• 5555"}`}</div>
          {mode === "ext" && <div style={{ background: C.accentLt, border: `1px solid ${C.accentBd}`, borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 11, color: C.accent }}>📞 Your extension is ringing — listen for the 6-digit code</div>}
          <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 18 }}>{[4,8,2,9,1,7].map((d, i) => <input key={i} value={d} readOnly style={{ width: 40, height: 48, textAlign: "center", fontSize: 18, fontWeight: 600, fontFamily: "monospace", border: `1.5px solid ${C.border}`, borderRadius: 8, outline: "none" }} />)}</div>
          <button onClick={() => onLogin(USERS[0])} style={{ ...S.btnP, width: "100%", padding: 11 }}>Verify & sign in</button>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 12 }}>Didn't get it? <span style={{ color: C.accent, cursor: "pointer" }}>{mode === "ext" ? "Call again" : "Resend SMS"}</span></div>
        </>}
      </div>
    </div>
  );
}

/* ─── Main App ─── */
export default function App() {
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("calls");
  const [isAdmin, setIsAdmin] = useState(false);

  const login = (u) => { setUser(u); setIsAdmin(u.role === "admin"); setPage("calls"); };
  const adminPages = [
    { id: "ivr", label: "IVR editor", icon: "⚡" },
    { id: "extensions", label: "Extensions", icon: "👥" },
    { id: "costs", label: "Costs", icon: "💲" },
  ];
  const userPages = [
    { id: "calls", label: "Call logs", icon: "📞" },
    { id: "voicemail", label: "Voicemail", icon: "📩", badge: 3 },
    { id: "settings", label: "Settings", icon: "⚙️" },
  ];

  if (!user) return <LoginScreen onLogin={login} />;

  return (
    <div style={{ fontFamily: "'DM Sans', -apple-system, sans-serif", display: "flex", height: "100vh", background: C.bg, fontSize: 13 }}>
      {/* Sidebar */}
      <nav style={{ width: 210, minWidth: 210, background: C.side, display: "flex", flexDirection: "column", overflow: "auto" }}>
        <div style={{ padding: "20px 16px 16px" }}><div style={{ fontSize: 16, fontWeight: 600, color: "#FFF" }}>UniSip</div><div style={{ fontSize: 10, color: "#71717A", textTransform: "uppercase", letterSpacing: 1.2, marginTop: 2 }}>Phone System</div></div>

        <div style={{ padding: "8px 8px 4px" }}><div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "rgba(255,255,255,0.2)", padding: "0 8px", marginBottom: 4 }}>User</div>
          {userPages.map(p => (
            <div key={p.id} onClick={() => setPage(p.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 7, cursor: "pointer", color: page === p.id ? "#FFF" : "#888", background: page === p.id ? C.sideActive : "transparent", fontSize: 12, fontWeight: page === p.id ? 500 : 400, transition: "0.1s", marginBottom: 1 }}>
              <span style={{ fontSize: 14, width: 20, textAlign: "center" }}>{p.icon}</span>{p.label}
              {p.badge && <span style={{ marginLeft: "auto", background: C.accent, color: "#FFF", fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 8 }}>{p.badge}</span>}
            </div>
          ))}
        </div>

        {isAdmin && <div style={{ padding: "8px 8px 4px" }}><div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "rgba(255,255,255,0.2)", padding: "0 8px", marginBottom: 4 }}>Admin</div>
          {adminPages.map(p => (
            <div key={p.id} onClick={() => setPage(p.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 7, cursor: "pointer", color: page === p.id ? "#FFF" : "#888", background: page === p.id ? C.sideActive : "transparent", fontSize: 12, fontWeight: page === p.id ? 500 : 400, transition: "0.1s", marginBottom: 1 }}>
              <span style={{ fontSize: 14, width: 20, textAlign: "center" }}>{p.icon}</span>{p.label}
            </div>
          ))}
        </div>}

        <div style={{ marginTop: "auto", padding: 12, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <div onClick={() => setIsAdmin(!isAdmin)} style={{ display: "flex", alignItems: "center", gap: 8, padding: 8, borderRadius: 7, cursor: "pointer" }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: C.accent, color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600 }}>{user.name.split(" ").map(n => n[0]).join("")}</div>
            <div><div style={{ fontSize: 11, fontWeight: 500, color: "#FFF" }}>{user.name}</div><div style={{ fontSize: 9, color: "#71717A" }}>{user.ext ? `Ext ${user.ext}` : "Forward only"} · {isAdmin ? "Admin" : "User"} <span style={{ color: C.accent, fontSize: 8 }}>toggle</span></div></div>
          </div>
        </div>
      </nav>

      {/* Main */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ background: `linear-gradient(90deg, ${C.accent}, ${C.purple})`, color: "#FFF", textAlign: "center", padding: 6, fontSize: 10, fontWeight: 500, letterSpacing: 0.5 }}>DEMO — Click your name in sidebar to toggle Admin/User view</div>
        <div style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
          {page === "calls" && <CallsPage />}
          {page === "voicemail" && <VoicemailPage />}
          {page === "settings" && <SettingsPage user={user} />}
          {page === "ivr" && <IVRPage />}
          {page === "extensions" && <ExtensionsPage />}
          {page === "costs" && <CostsPage />}
        </div>
      </main>
    </div>
  );
}
