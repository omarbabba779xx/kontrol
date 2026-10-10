"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import { ChevronDown, ListPlus, Wand2 } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type Priority = "low" | "medium" | "high" | "critical";
type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
type Task = { id: string; title: string; description: string; source_type: string; source_id: string | null; uc_code: string | null; assignee_id: string | null; assignee_name: string | null; priority: Priority; status: TaskStatus; due_at: string | null; created_at: string; closed_at: string | null; overdue: boolean; comments: Array<{ id: string; author_id: string; body: string; created_at: string }> };
type Person = { id: string; name: string; role: string };

const PRIORITY_STYLE: Record<Priority, string> = { critical: "bg-[#f5e5e1] text-[#9f2923]", high: "bg-[#f6e3d3] text-[#944a15]", medium: "bg-[#f1e7cc] text-[#7a5a1a]", low: "bg-[#e5e2d8] text-[#55534b]" };
const STATUSES: TaskStatus[] = ["open", "in_progress", "blocked", "done", "cancelled"];
const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[12px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[12px] focus-visible:outline-2 focus-visible:outline-[#171713]";
const filters = ["Open", "Mine", "Overdue", "Done"] as const;
type Filter = (typeof filters)[number];

export function TasksBoard() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [me, setMe] = useState("");
  const [filter, setFilter] = useState<Filter>("Open");
  const [open, setOpen] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState("Loading…");
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", priority: "medium" as Priority, dueAt: "", assigneeId: "" });
  const [isPending, startTransition] = useTransition();

  const load = useCallback((signal?: AbortSignal) => Promise.all([fetchJson<{ tasks: Task[] }>("/api/tasks", { signal }), fetchJson<{ users: Person[]; me: string }>("/api/users", { signal })]).then(([taskData, userData]) => { setTasks(taskData.tasks); setPeople(userData.users); setMe(userData.me); setFailed(false); }), []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(() => setStatus("Up to date")).catch((error: unknown) => { if (!isAbort(error)) { setFailed(true); setStatus(errorMessage(error, "Tasks unavailable")); } });
    return () => controller.abort();
  }, [load]);

  function act(body: Record<string, unknown>, success: string, after?: () => void) {
    startTransition(async () => {
      try { setStatus("Saving…"); await fetchJson("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
      catch (error) { setStatus(errorMessage(error, "Action failed")); return; }
      try { await load(); setStatus(success); after?.(); } catch (error) { setStatus(`Done, but refresh failed: ${errorMessage(error, "unknown error")}`); }
    });
  }

  const visible = (tasks ?? []).filter((task) => filter === "Open" ? ["open", "in_progress", "blocked"].includes(task.status) : filter === "Mine" ? task.assignee_id === me && ["open", "in_progress", "blocked"].includes(task.status) : filter === "Overdue" ? task.overdue : task.status === "done");
  const counts = { open: (tasks ?? []).filter((task) => ["open", "in_progress", "blocked"].includes(task.status)).length, overdue: (tasks ?? []).filter((task) => task.overdue).length, done: (tasks ?? []).filter((task) => task.status === "done").length };
  const day = (value: string | null) => (value ? value.slice(0, 10) : "no date");

  return (
    <div>
      <PageHeading index="14" title="Remediation tasks" description="Turn gaps, findings and reviews into owned, dated work. Assignees and overdue items are notified through your channels." meta={status} action={<Button type="button" variant="outline" disabled={isPending} onClick={() => act({ action: "from_roadmap", limit: 10 }, "Tasks created from the roadmap")} className="h-8 rounded-none border-[#171713] bg-transparent text-[11px]"><Wand2 className="me-1.5 h-3 w-3" aria-hidden="true" />Generate from roadmap</Button>} />
      <section className="p-5 sm:p-7 lg:p-9" aria-busy={tasks === null && !failed}>
        {failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[11px] text-[#9f2923]">{status}</div> : null}
        <div className="mb-6 grid grid-cols-3 border border-[#cbc7bd]">{[["Open", counts.open], ["Overdue", counts.overdue], ["Done", counts.done]].map(([label, value]) => <div key={label} className="border-e border-[#cbc7bd] p-4 last:border-e-0"><MicroLabel>{label}</MicroLabel><p className={cn("mt-1 text-2xl font-semibold", label === "Overdue" && Number(value) > 0 && "text-[#b8322a]")}>{value}</p></div>)}</div>

        <div className="grid grid-cols-1 gap-8 xl:grid-cols-[320px_minmax(0,1fr)]">
          <form className="h-fit space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "create", title: form.title, description: form.description || undefined, priority: form.priority, dueAt: form.dueAt ? `${form.dueAt}T12:00:00.000Z` : undefined, assigneeId: form.assigneeId || undefined }, "Task created", () => setForm({ title: "", description: "", priority: "medium", dueAt: "", assigneeId: "" })); }}>
            <MicroLabel>New task</MicroLabel>
            <Input aria-label="Task title" placeholder="What needs to be done" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={field} />
            <Textarea aria-label="Task description" placeholder="Context, acceptance criteria (optional)" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="min-h-16 rounded-none text-[12px] placeholder:text-[#63615a]" />
            <div className="flex gap-2"><select aria-label="Priority" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as Priority })} className={select}>{(["low", "medium", "high", "critical"] as Priority[]).map((value) => <option key={value}>{value}</option>)}</select><Input aria-label="Due date" type="date" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} className={cn(field, "flex-1")} /></div>
            <select aria-label="Assignee" value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value })} className={cn(select, "w-full")}><option value="">Unassigned</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name} ({person.role.replace("_", " ")})</option>)}</select>
            <Button type="submit" disabled={isPending || form.title.trim().length < 3} className="h-8 w-full rounded-none bg-[#171713] text-[12px] text-white"><ListPlus className="me-1.5 h-3 w-3" aria-hidden="true" />Create task</Button>
          </form>

          <div>
            <div role="group" aria-label="Task filter" className="mb-3 flex flex-wrap gap-2">{filters.map((name) => <button key={name} type="button" aria-pressed={filter === name} onClick={() => setFilter(name)} className={cn("border px-3 py-1.5 text-[12px]", filter === name ? "border-[#171713] bg-[#171713] text-white" : "border-[#cbc7bd] hover:border-[#171713]")}>{name}</button>)}</div>
            <div tabIndex={0} role="region" aria-label="Tasks table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[820px] text-left text-[11px]"><caption className="sr-only">Tasks</caption>
              <thead><tr className="bg-[#e9e5db] font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]">{["Task", "Priority", "Status", "Assignee", "Due", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
              <tbody>{visible.map((task) => (
                <Fragment key={task.id}>
                  <tr className="border-t border-[#d8d4ca] align-top">
                    <td className="max-w-[320px] px-3 py-3"><span className="block font-medium">{task.title}</span><span className="font-mono text-[10px] text-[#5f5d56]">{task.source_type}{task.uc_code ? ` · ${task.uc_code}` : ""}</span></td>
                    <td className="px-3 py-3"><span className={cn("px-1.5 py-0.5 font-mono text-[10px] uppercase", PRIORITY_STYLE[task.priority])}>{task.priority}</span></td>
                    <td className="px-3 py-3"><select aria-label={`Status of ${task.title}`} value={task.status} disabled={isPending} onChange={(event) => act({ action: "update", id: task.id, status: event.target.value }, "Task updated")} className={select}>{STATUSES.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select></td>
                    <td className="px-3 py-3"><select aria-label={`Assignee of ${task.title}`} value={task.assignee_id ?? ""} disabled={isPending} onChange={(event) => act({ action: "update", id: task.id, assigneeId: event.target.value || null }, "Task reassigned")} className={select}><option value="">Unassigned</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></td>
                    <td className={cn("px-3 py-3 font-mono", task.overdue && "font-bold text-[#b8322a]")}>{day(task.due_at)}{task.overdue ? " · OVERDUE" : ""}</td>
                    <td className="px-3 py-3 text-end"><Button type="button" variant="ghost" aria-expanded={open === task.id} onClick={() => { setOpen(open === task.id ? null : task.id); setComment(""); }} className="h-6 rounded-none px-1 text-[10px]">Details ({task.comments.length}) <ChevronDown className={cn("ms-0.5 h-2.5 w-2.5 transition-transform", open === task.id && "rotate-180")} aria-hidden="true" /></Button></td>
                  </tr>
                  {open === task.id ? <tr className="bg-[#f1eee5]"><td colSpan={6} className="px-5 py-4"><div className="max-w-2xl space-y-2">
                    {task.description ? <p className="whitespace-pre-wrap text-[11px] text-[#34332e]">{task.description}</p> : <p className="text-[11px] text-[#5f5d56]">No description.</p>}
                    {task.comments.map((item) => <p key={item.id} className="border-s-2 border-[#cbc7bd] ps-2 text-[11px]"><span className="font-mono text-[10px] text-[#5f5d56]">{item.created_at.slice(0, 10)} · {people.find((person) => person.id === item.author_id)?.name ?? item.author_id}</span><br />{item.body}</p>)}
                    <div className="flex gap-2"><Input aria-label={`Comment on ${task.title}`} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment" className={cn(field, "flex-1")} /><Button type="button" disabled={isPending || comment.trim().length < 2} onClick={() => act({ action: "comment", taskId: task.id, body: comment }, "Comment added", () => setComment(""))} className="h-8 rounded-none bg-[#171713] text-[11px] text-white">Comment</Button></div>
                  </div></td></tr> : null}
                </Fragment>))}</tbody></table>
              {tasks !== null && visible.length === 0 ? <p className="p-8 text-center text-[12px] text-[#5f5d56]">Nothing here. {filter === "Open" ? "Create a task, or generate tasks from the compliance roadmap." : ""}</p> : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
