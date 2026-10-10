"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Archive,
  ClipboardCheck,
  Network,
  Gauge,
  Bot,
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

/** The management-system modules come first; the rest of the platform follows in its own section. Codes follow that order. */
const GOVERNANCE = ["/", "/isms", "/compliance", "/risk-register", "/audit", "/tasks", "/third-party", "/evidence", "/admin"];

const navigation = [
  { name: "Decision room", code: "01", href: "/", icon: CircleDot },
  { name: "ISMS", code: "02", href: "/isms", icon: Landmark },
  { name: "Compliance hub", code: "03", href: "/compliance", icon: BadgeCheck },
  { name: "Risk register", code: "04", href: "/risk-register", icon: Gauge },
  { name: "Audit workspace", code: "05", href: "/audit", icon: ClipboardCheck },
  { name: "Remediation tasks", code: "06", href: "/tasks", icon: ListChecks },
  { name: "Third parties", code: "07", href: "/third-party", icon: Network },
  { name: "Evidence ledger", code: "08", href: "/evidence", icon: Archive },
  { name: "Administration", code: "09", href: "/admin", icon: UserCog },
  { name: "Scenario lab", code: "10", href: "/risks", icon: FlaskConical },
  { name: "Control graph", code: "11", href: "/controls", icon: GitFork },
  { name: "Model registry", code: "12", href: "/ai-systems", icon: Braces },
  { name: "Dependencies", code: "13", href: "/vendors", icon: Boxes },
  { name: "Reviews", code: "14", href: "/audits", icon: Shield },
  { name: "Change log", code: "15", href: "/intelligence", icon: FileClock },
  { name: "Control plane", code: "16", href: "/operations", icon: Activity },
  { name: "Assurance studio", code: "17", href: "/assurance", icon: ScanSearch },
  { name: "Enterprise platform", code: "18", href: "/enterprise", icon: Landmark },
  { name: "AI governance", code: "19", href: "/ai-governance", icon: Bot },
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
        <span className="font-mono text-[13px] font-bold">K/</span>
      </span>
      <span>
        <span className="block text-[14px] font-semibold tracking-[-.03em] text-[#171713]">KONTROL</span>
        <span className="block font-mono text-[10px] uppercase tracking-[.18em] text-[#5f5d56]">Decision assurance</span>
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
        className="h-8 w-[220px] rounded-none border-[#cbc7bd] bg-transparent ps-8 pe-9 text-[12px] shadow-none placeholder:text-[#63615a]"
      />
      <datalist id="kontrol-pages">{pages.map((item) => <option key={item.href} value={item.name} />)}</datalist>
      <span aria-hidden="true" className="pointer-events-none absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1 font-mono text-[10px] text-[#63615a]"><Command className="h-2.5 w-2.5" />K</span>
    </form>
  );
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const pages = useVisibleNavigation();
  const navRef = useRef<HTMLElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);

  // The marker slides to the current page; until it is placed, the link carries its own background.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const marker = markerRef.current;
    if (!nav || !marker) return;
    const current = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!current) {
      marker.style.opacity = "0";
      return;
    }
    marker.style.opacity = "1";
    marker.style.height = `${current.offsetHeight}px`;
    marker.style.transform = `translateY(${current.offsetTop}px)`;
    nav.dataset.ready = "true";
  }, [pathname, pages]);

  return (
    <nav ref={navRef} aria-label="Primary navigation" className="nav-rail relative mt-10">
      <span ref={markerRef} aria-hidden="true" className="nav-marker" />
      <div className="mb-3 flex items-center justify-between px-2 font-mono text-[10px] uppercase tracking-[.16em] text-[#63615a]">
        <span>Workspace</span><span>Demo / EU</span>
      </div>
      {[
        { title: "Governance", items: GOVERNANCE.map((href) => pages.find((item) => item.href === href)).filter((item): item is (typeof pages)[number] => item !== undefined) },
        { title: "Other modules", items: pages.filter((item) => !GOVERNANCE.includes(item.href)) },
      ].filter((section) => section.items.length > 0).map((section, index) => (
      <div key={section.title} className={cn("border-t border-[#d7d3c9]", index > 0 && "mt-6")}>
        {index > 0 ? <p className="px-2 py-2 font-mono text-[10px] uppercase tracking-[.16em] text-[#63615a]">{section.title}</p> : null}
        {section.items.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={cn(
                "nav-link group relative grid min-h-11 grid-cols-[24px_1fr_16px] items-center gap-2 border-b border-[#d7d3c9] px-2 text-[13px] transition-colors duration-200",
                active ? "bg-[#171713] text-[#f7f4ed]" : "text-[#5f5d56] hover:bg-[#e8e4da] hover:text-[#171713]",
              )}
            >
              <span className={cn("font-mono text-[10px]", active ? "text-[#f4673b]" : "text-[#63615a]")}>{item.code}</span>
              <span className="font-medium">{item.name}</span>
              <item.icon className={cn("h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5", active ? "text-[#f7f4ed]" : "text-[#63615a] group-hover:text-[#171713]")} strokeWidth={1.6} />
            </Link>
          );
        })}
      </div>
      ))}
    </nav>
  );
}

function Sidebar() {
  return (
    <aside className="fixed inset-y-0 start-0 z-30 hidden w-[256px] border-e border-[#cbc7bd] bg-[#efebe2] lg:flex lg:flex-col">
      <div className="px-5 pt-5"><Mark /><Navigation /></div>
      <div className="mt-auto border-t border-[#cbc7bd] p-4">
        <div className="mb-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]"><span>Data state</span><span className="flex items-center gap-1.5 text-[#7a5a1a]"><span className="h-1.5 w-1.5 rounded-full bg-[#7a5a1a]" aria-hidden="true" />Sample data</span></div>
        <button type="button" className="flex w-full items-center gap-3 border-t border-[#d7d3c9] pt-3 text-start">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[#d9d4c8] font-mono text-[11px] text-[#34332e]">LM</span>
          <span className="min-w-0"><span className="block truncate text-[12px] font-semibold text-[#34332e]">Leila Mansour</span><span className="block truncate text-[10px] text-[#63615a]">AI Risk Owner</span></span>
          <ChevronDown className="ms-auto h-3 w-3 text-[#63615a]" />
        </button>
      </div>
    </aside>
  );
}

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  return (
    <TooltipProvider>
      <div className="min-h-screen w-full bg-[#f4f1e9] text-[#1c1c18]">
        <a href="#main-content" className="sr-only z-50 bg-[#171713] px-3 py-2 text-[12px] text-white focus:not-sr-only focus:fixed focus:start-2 focus:top-2">Skip to content</a>
        <Sidebar />
        <div className="min-w-0 lg:ps-[256px]">
          <header className="sticky top-0 z-20 flex h-14 items-center border-b border-[#cbc7bd] bg-[#f4f1e9]/95 px-4 backdrop-blur-sm sm:px-6 lg:px-8">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger render={<Button variant="ghost" size="icon" className="me-3 h-8 w-8 rounded-none lg:hidden" aria-label="Open navigation" />}><Menu className="h-4 w-4" /></SheetTrigger>
              <SheetContent side="left" className="w-[278px] border-[#cbc7bd] bg-[#efebe2] p-5 text-[#171713]"><SheetTitle className="sr-only">Navigation</SheetTitle><Mark /><Navigation onNavigate={() => setMenuOpen(false)} /></SheetContent>
            </Sheet>
            <div className="hidden items-center gap-3 sm:flex">
              <span className="font-mono text-[10px] uppercase tracking-[.16em] text-[#63615a]">Portfolio</span>
              <span className="text-[12px] font-medium text-[#2d2c28]">EU Consumer Lending</span>
              <span className="h-3 w-px bg-[#cbc7bd]" />
              <span className="font-mono text-[10px] text-[#63615a]">SAMPLE PORTFOLIO · ILLUSTRATIVE DATA</span>
            </div>
            <div className="ms-auto flex items-center gap-2">
              <PageJump />
              <a
                href="/api/oscal/export"
                download
                className="inline-flex h-8 items-center border border-[#171713] bg-transparent px-3 text-[11px] font-semibold text-[#171713] transition-colors hover:bg-[#171713] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#171713]"
              >
                Export OSCAL <ArrowUpRight aria-hidden="true" className="ms-1.5 h-3 w-3" />
              </a>
            </div>
          </header>
          <main id="main-content" className="min-h-[calc(100vh-56px)] min-w-0 overflow-x-hidden"><div key={pathname} className="page-enter">{children}</div></main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export function PageHeading({ index, title, description, meta, action }: { index: string; title: string; description: string; meta?: string; action?: React.ReactNode }) {
  const pathname = usePathname();
  const page = navigation.find((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)));
  const code = page ? `${page.code} / ${navigation.length}` : index;
  return (
    <div className="grid gap-5 border-b border-[#cbc7bd] px-5 py-7 sm:px-7 lg:grid-cols-[1fr_auto] lg:px-9">
      <div className="flex gap-4">
        <span className="mt-2 whitespace-nowrap font-mono text-[11px] text-[#a8391a]">{code}</span>
        <div><h1 className="font-display text-[40px] leading-[.95] tracking-[-.02em] text-[#171713] sm:text-[54px]">{title}</h1><p className="mt-4 max-w-2xl text-[14px] leading-6 text-[#5f5c55]">{description}</p></div>
      </div>
      <div className="flex items-end gap-3">{meta ? <span role="status" aria-live="polite" className="font-mono text-[10px] uppercase tracking-[.13em] text-[#63615a]">{meta}</span> : null}{action}</div>
    </div>
  );
}

export function MicroLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[10px] uppercase tracking-[.14em] text-[#63615a]", className)}>{children}</span>;
}
