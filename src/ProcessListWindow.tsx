import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./ProcessListWindow.css";

type RunningProcess = {
  pid: number;
  name: string;
  displayName: string;
  executable?: string;
  iconDataUrl?: string;
};

type GameService = { id: string; games: Array<{ executablePath?: string }> };

type ProcessGameAdded = {
  services: GameService[];
  serviceId: string;
  processName: string;
  executable: string;
};

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>;
}

function FallbackIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden><path d="M6.5 8h11a4 4 0 0 1 3.8 5.2l-1.1 3.3a2.5 2.5 0 0 1-4.1 1l-1.7-1.5H9.6l-1.7 1.5a2.5 2.5 0 0 1-4.1-1l-1.1-3.3A4 4 0 0 1 6.5 8Z"/><path d="M7 11v4M5 13h4M16 12h.01M18 14h.01"/></svg>;
}

export default function ProcessListWindow() {
  const [processes, setProcesses] = useState<RunningProcess[]>([]);
  const [selected, setSelected] = useState<RunningProcess>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [active, setActive] = useState(false);

  async function refresh() {
    try {
      const fresh = await invoke<RunningProcess[]>("list_running_processes");
      setProcesses(fresh);
      setSelected(current => current
        ? fresh.find(process => process.executable?.toLowerCase() === current.executable?.toLowerCase())
        : undefined);
      setError(undefined);
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    let disposed = false;
    let stopOpened: (() => void) | undefined;
    let stopCloseRequested: (() => void) | undefined;
    const currentWindow = getCurrentWindow();
    void currentWindow.isVisible().then(visible => setActive(visible));
    void listen("process-list-opened", () => {
      setError(undefined);
      setOpening(false);
      setActive(true);
    }).then(unlisten => { if (disposed) unlisten(); else stopOpened = unlisten; });
    void currentWindow.onCloseRequested(event => {
      event.preventDefault();
      setActive(false);
      setSelected(undefined);
      void invoke("close_process_list").catch(reason => setError(String(reason)));
    }).then(unlisten => { if (disposed) unlisten(); else stopCloseRequested = unlisten; });
    return () => {
      disposed = true;
      stopOpened?.();
      stopCloseRequested?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void hideProcessList();
      if (event.key === "Enter" && selected) void addSelected(selected);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  async function hideProcessList() {
    setActive(false);
    setSelected(undefined);
    await invoke("close_process_list");
  }

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term
      ? processes.filter(process => `${process.displayName} ${process.name}`.toLowerCase().includes(term))
      : processes;
  }, [processes, query]);

  async function addSelected(process: RunningProcess) {
    if (opening || !process.executable) return;
    setOpening(true);
    setError(undefined);
    try {
      const serviceId = await invoke<string>("get_process_list_service_id");
      const services = await invoke<GameService[]>("learn_process_game", { serviceId, pid: process.pid });
      await invoke("save_target", { target: { processName: process.name, executable: process.executable } });
      const payload: ProcessGameAdded = {
        services,
        serviceId,
        processName: process.name,
        executable: process.executable,
      };
      await emitTo("main", "process-game-added", payload);
      await hideProcessList();
    } catch (reason) {
      setError(String(reason));
      setOpening(false);
    }
  }

  return <main className="process-window">
    <label className="process-window-search">
      <SearchIcon />
      <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search applications" />
    </label>
    <div className="process-window-list" role="listbox" aria-label="Open applications">
      {filtered.map(process => {
        const isSelected = selected?.executable?.toLowerCase() === process.executable?.toLowerCase();
        return <button
          key={process.executable ?? process.pid}
          className={isSelected ? "selected" : ""}
          role="option"
          aria-selected={isSelected}
          onClick={() => setSelected(process)}
          onDoubleClick={() => void addSelected(process)}
        >
          <span className="application-icon">{process.iconDataUrl ? <img src={process.iconDataUrl} alt="" /> : <FallbackIcon />}</span>
          <span className="application-copy"><strong>{process.displayName}</strong><small>{process.name}</small></span>
        </button>;
      })}
      {!filtered.length && <div className="process-window-empty"><FallbackIcon/><strong>No open games found</strong><p>Launch the game you want to add and it will appear here.</p></div>}
    </div>
    {error && <div className="process-window-error" role="alert">{error}</div>}
    <footer>
      <button disabled={!selected || opening} onClick={() => selected && void addSelected(selected)}>{opening ? "Opening…" : "Open"}</button>
      <button onClick={() => void hideProcessList()}>Cancel</button>
    </footer>
  </main>;
}
