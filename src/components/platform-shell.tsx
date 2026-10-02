"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Archive,
  ClipboardCheck,
  BadgeCheck,
  UserCog,
  ListChecks,
  ArrowUpRight,
  Boxes,
  Braces,
  ChevronDown,
  CircleDot,
  Command,
  FileClock,
  FlaskConical,
  GitFork,
  Menu,
  Search,
  Shield,
  Activity,
  ScanSearch,
  Landmark,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Decision room", code: "01", href: "/", icon: CircleDot },
  { name: "Scenario lab", code: "02", href: "/risks", icon: FlaskConical },
  { name: "Control graph", code: "03", href: "/controls", icon: GitFork },
  { name: "Model registry", code: "04", href: "/ai-systems", icon: Braces },
  { name: "Evidence ledger", code: "05", href: "/evidence", icon: Archive },
  { name: "Dependencies", code: "06", href: "/vendors", icon: Boxes },
  { name: "Reviews", code: "07", href: "/audits", icon: Shield },
  { name: "Change log", code: "08", href: "/intelligence", icon: FileClock },
  { name: "Control plane", code: "09", href: "/operations", icon: Activity },
  { name: "Assurance studio", code: "10", href: "/assurance", icon: ScanSearch },
  { name: "Enterprise platform", code: "11", href: "/enterprise", icon: Landmark },
  { name: "Compliance hub", code: "12", href: "/compliance", icon: BadgeCheck },
  { name: "Administration", code: "13", href: "/admin", icon: UserCog },
  { name: "Remediation tasks", code: "14", href: "/tasks", icon: ListChecks },
  { name: "Audit workspace", code: "15", href: "/audit", icon: ClipboardCheck },
];

/** External auditors only see the audit workspace; everyone else sees the full navigation. */
function useVisibleNavigation() {
  const [external, setExternal] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/me", { signal: controller.signal }).then((response) => (response.ok ? response.json() : null)).then((me: { external?: boolean } | null) => setExternal(me?.external === true)).catch(() => undefined);
    return () => controller.abort();
  }, []);
  return external ? navigation.filter((item) => item.href === "/audit") : navigation;
}

function Mark() {
  return (
    <Link href="/" className="group flex items-center gap-2.5" aria-label="Kontrol home">
      <span className="grid h-8 w-8 place-items-center border border-[#171713] bg-[#171713] text-[#f2efe7] transition-transform group-hover:-rotate-3">
        <span className="font-mono text-[11px] font-bold">K/</span>
      </span>
      <span>
        <span className="block text-[13px] font-semibold tracking-[-.03em] text-[#171713]">KONTROL</span>
        <span className="block font-mono text-[8px] uppercase tracking-[.18em] text-[#5f5d56]">Decision assurance</span>
      </span>
    </Link>
  );
}

function PageJump() {
  const router = useRouter();
  const pages = useVisibleNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const query = value.trim().toLowerCase();
    const match = pages.find((item) => item.name.toLowerCase() === query) ?? pages.find((item) => item.name.toLowerCase().includes(query));
    if (!match) return;
    router.push(match.href);
    setValue("");
    inputRef.current?.blur();
  }

  return (
    <form onSubmit={submit} role="search" className="relative hidden md:block">
      <Search aria-hidden="true" className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#63615a]" />
      <Input
        ref={inputRef}
        type="search"
        list="kontrol-pages"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label="Jump to a page"
        placeholder="Jump to a page…"
        className="h-8 w-[220px] rounded-none border-[#cbc7bd] bg-transparent ps-8 pe-9 text-[10px] shadow-none placeholder:text-[#63615a]"
      />
      <datalist id="kontrol-pages">{pages.map((item) => <option key={item.href} value={item.name} />)}</datalist>
      <span aria-hidden="true" className="pointer-events-none absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1 font-mono text-[8px] text-[#63615a]"><Command className="h-2.5 w-2.5" />K</span>
    </form>
  );
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const pages = useVisibleNavigation();
  return (
    <nav aria-label="Primary navigation" className="mt-10">
      <div className="mb-3 flex items-center justify-between px-2 font-mono text-[8px] uppercase tracking-[.16em] text-[#63615a]">
        <span>Workspace</span><span>Demo / EU</span>
      </div>
      <div className="border-t border-[#d7d3c9]">
        {pages.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={cn(
                "group grid min-h-11 grid-cols-[24px_1fr_16px] items-center gap-2 border-b border-[#d7d3c9] px-2 text-[11px] transition-colors",
                active ? "bg-[#171713] text-[#f7f4ed]" : "text-[#5f5d56] hover:bg-[#e8e4da] hover:text-[#171713]",
              )}
            >
              <span className={cn("font-mono text-[8px]", active ? "text-[#f4673b]" : "text-[#63615a]")}>{item.code}</span>
              <span className="font-medium">{item.name}</span>
              <item.icon className={cn("h-3.5 w-3.5", active ? "text-[#f7f4ed]" : "text-[#63615a] group-hover:text-[#171713]")} strokeWidth={1.6} />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function Sidebar() {
  return (
    <aside className="fixed inset-y-0 start-0 z-30 hidden w-[224px] border-e border-[#cbc7bd] bg-[#efebe2] lg:flex lg:flex-col">
      <div className="px-5 pt-5"><Mark /><Navigation /></div>
      <div className="mt-auto border-t border-[#cbc7bd] p-4">
        <div className="mb-4 flex items-center justify-between font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]"><span>Data state</span><span className="flex items-center gap-1.5 text-[#7a5a1a]"><span className="h-1.5 w-1.5 rounded-full bg-[#7a5a1a]" aria-hidden="true" />Sample data</span></div>
        <button type="button" className="flex w-full items-center gap-3 border-t border-[#d7d3c9] pt-3 text-start">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[#d9d4c8] font-mono text-[9px] text-[#34332e]">LM</span>
          <span className="min-w-0"><span className="block truncate text-[10px] font-semibold text-[#34332e]">Leila Mansour</span><span className="block truncate text-[8px] text-[#63615a]">AI Risk Owner</span></span>
          <ChevronDown className="ms-auto h-3 w-3 text-[#63615a]" />
        </button>
      </div>
    </aside>
  );
}

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <TooltipProvider>
      <div className="min-h-screen w-full bg-[#f4f1e9] text-[#1c1c18]">
        <a href="#main-content" className="sr-only z-50 bg-[#171713] px-3 py-2 text-[10px] text-white focus:not-sr-only focus:fixed focus:start-2 focus:top-2">Skip to content</a>
        <Sidebar />
        <div className="min-w-0 lg:ps-[224px]">
          <header className="sticky top-0 z-20 flex h-14 items-center border-b border-[#cbc7bd] bg-[#f4f1e9]/95 px-4 backdrop-blur-sm sm:px-6 lg:px-8">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger render={<Button variant="ghost" size="icon" className="me-3 h-8 w-8 rounded-none lg:hidden" aria-label="Open navigation" />}><Menu className="h-4 w-4" /></SheetTrigger>
              <SheetContent side="left" className="w-[278px] border-[#cbc7bd] bg-[#efebe2] p-5 text-[#171713]"><SheetTitle className="sr-only">Navigation</SheetTitle><Mark /><Navigation onNavigate={() => setMenuOpen(false)} /></SheetContent>
            </Sheet>
            <div className="hidden items-center gap-3 sm:flex">
              <span className="font-mono text-[8px] uppercase tracking-[.16em] text-[#63615a]">Portfolio</span>
              <span className="text-[10px] font-medium text-[#2d2c28]">EU Consumer Lending</span>
              <span className="h-3 w-px bg-[#cbc7bd]" />
              <span className="font-mono text-[8px] text-[#63615a]">SAMPLE PORTFOLIO · ILLUSTRATIVE DATA</span>
            </div>
            <div className="ms-auto flex items-center gap-2">
              <PageJump />
              <a
                href="/api/oscal/export"
                download
                className="inline-flex h-8 items-center border border-[#171713] bg-transparent px-3 text-[9px] font-semibold text-[#171713] transition-colors hover:bg-[#171713] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#171713]"
              >
                Export OSCAL <ArrowUpRight aria-hidden="true" className="ms-1.5 h-3 w-3" />
              </a>
            </div>
          </header>
          <main id="main-content" className="min-h-[calc(100vh-56px)] min-w-0 overflow-x-hidden">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export function PageHeading({ index, title, description, meta, action }: { index: string; title: string; description: string; meta?: string; action?: React.ReactNode }) {
  return (
    <div className="grid gap-5 border-b border-[#cbc7bd] px-5 py-7 sm:px-7 lg:grid-cols-[1fr_auto] lg:px-9">
      <div className="flex gap-4">
        <span className="mt-1 font-mono text-[9px] text-[#a8391a]">{index}</span>
        <div><h1 className="text-[28px] font-medium leading-none tracking-[-.045em] text-[#171713] sm:text-[36px]">{title}</h1><p className="mt-3 max-w-2xl text-[11px] leading-5 text-[#6f6c64]">{description}</p></div>
      </div>
      <div className="flex items-end gap-3">{meta ? <span role="status" aria-live="polite" className="font-mono text-[8px] uppercase tracking-[.13em] text-[#63615a]">{meta}</span> : null}{action}</div>
    </div>
  );
}

export function MicroLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[8px] uppercase tracking-[.14em] text-[#63615a]", className)}>{children}</span>;
}
