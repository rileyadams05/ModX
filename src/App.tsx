import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

type RunningProcess = { pid: number; name: string; displayName: string; executable?: string; iconDataUrl?: string };
type SavedTarget = { processName: string; executable?: string };
type LibraryGame = { id: string; serviceId: string; displayName: string; installPath: string; executablePath?: string; executableName?: string; discoverySource: "mainLibrary" | "savedProcess"; isAvailable: boolean; iconDataUrl?: string; hasCustomIcon: boolean; needsIconUpgrade: boolean };
type GameService = { id: string; name: string; mainLibraryPath: string; createdAt: number; updatedAt: number; pathAvailable: boolean; games: LibraryGame[]; scanError?: string; iconDataUrl?: string; hasCustomIcon: boolean };
type ProcessGameAdded = { services: GameService[]; serviceId: string; processName: string; executable: string };
type View = { kind: "service"; serviceId: string } | { kind: "empty" };
type IconName = "games" | "community" | "settings" | "search" | "process" | "check" | "clock" | "close" | "shield" | "refresh" | "chevron" | "gamepad" | "plus" | "folder" | "play" | "trash";

const icons: Record<IconName, React.ReactNode> = {
  games: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h7M7 16h5"/></>,
  community: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5a1.8 1.8 0 0 0 .4 2l.1.1-2.8 2.8-.1-.1a1.8 1.8 0 0 0-2-.4 1.8 1.8 0 0 0-1.1 1.7v.2h-4v-.2A1.8 1.8 0 0 0 8.4 18a1.8 1.8 0 0 0-2 .4l-.1.1-2.8-2.8.1-.1a1.8 1.8 0 0 0 .4-2A1.8 1.8 0 0 0 2.3 12h-.2V8h.2A1.8 1.8 0 0 0 4 6.9a1.8 1.8 0 0 0-.4-2l-.1-.1L6.3 2l.1.1a1.8 1.8 0 0 0 2 .4A1.8 1.8 0 0 0 9.5.8V.6h4v.2a1.8 1.8 0 0 0 1.1 1.7 1.8 1.8 0 0 0 2-.4l.1-.1 2.8 2.8-.1.1a1.8 1.8 0 0 0-.4 2A1.8 1.8 0 0 0 20.7 8h.2v4h-.2a1.8 1.8 0 0 0-1.7 1.5Z"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  process: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
  check: <path d="m5 12 4 4L19 6"/>, clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, close: <path d="m6 6 12 12M18 6 6 18"/>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>, refresh: <><path d="M20 11a8 8 0 1 0 2 5"/><path d="M20 4v7h-7"/></>, chevron: <path d="m9 18 6-6-6-6"/>,
  gamepad: <><path d="M6.5 8h11a4 4 0 0 1 3.8 5.2l-1.1 3.3a2.5 2.5 0 0 1-4.1 1l-1.7-1.5H9.6l-1.7 1.5a2.5 2.5 0 0 1-4.1-1l-1.1-3.3A4 4 0 0 1 6.5 8Z"/><path d="M7 11v4M5 13h4M16 12h.01M18 14h.01"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, folder: <><path d="M3 7h7l2 2h9v10H3Z"/><path d="M3 7V5h7l2 2"/></>, play: <path d="m8 5 11 7-11 7Z"/>, trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></>,
};
function Icon({ name, size = 19 }: { name: IconName; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{icons[name]}</svg>; }
function diagnoseRenderedIcon(event: React.SyntheticEvent<HTMLImageElement>, label: string) { const image = event.currentTarget; console.info("[IconRenderer]", { label, source: "cached-data-url", originalWidth: image.naturalWidth, originalHeight: image.naturalHeight, renderedWidth: image.clientWidth, renderedHeight: image.clientHeight }); }

export default function App() {
  const [services, setServices] = useState<GameService[]>([]);
  const [processes, setProcesses] = useState<RunningProcess[]>([]);
  const [target, setTarget] = useState<SavedTarget>();
  const [view, setView] = useState<View>({ kind: "empty" });
  const [selectedGame, setSelectedGame] = useState<LibraryGame>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [setupServiceId, setSetupServiceId] = useState<string>();
  const [serviceMenu, setServiceMenu] = useState<{ serviceId: string; x: number; y: number }>();
  const [servicePendingDeletion, setServicePendingDeletion] = useState<GameService>();
  const [serviceName, setServiceName] = useState("");
  const [servicePath, setServicePath] = useState("");
  const [message, setMessage] = useState<string>();
  const scanRunning = useRef(false);
  const servicesRef = useRef<GameService[]>([]);
  const attemptedOnlineIcons = useRef(new Set<string>());
  const [resolvingIcons, setResolvingIcons] = useState<string[]>([]);

  function applyLibrary(fresh: GameService[]) {
    if (JSON.stringify(fresh) === JSON.stringify(servicesRef.current)) return;
    servicesRef.current = fresh; setServices(fresh);
    setSelectedGame(current => current ? fresh.flatMap(service => service.games).find(game => game.id === current.id) : undefined);
  }
  async function refreshLibrary(showLoading = false, serviceId?: string) {
    if (scanRunning.current) return;
    scanRunning.current = true;
    if (showLoading) { setLoading(true); setMessage(undefined); }
    try {
      const fresh = await invoke<GameService[]>("scan_game_library", { serviceId });
      applyLibrary(fresh);
      if (view.kind === "service" && !fresh.some(service => service.id === view.serviceId)) setView(fresh[0] ? { kind: "service", serviceId: fresh[0].id } : { kind: "empty" });
      if (view.kind === "empty" && fresh[0]) setView({ kind: "service", serviceId: fresh[0].id });
    } catch (error) { if (showLoading) setMessage(String(error)); }
    finally { scanRunning.current = false; if (showLoading) setLoading(false); }
  }
  async function refreshProcesses() {
    const fresh = await invoke<RunningProcess[]>("list_running_processes");
    setProcesses(fresh);
  }
  useEffect(() => {
    void invoke("frontend_ready");
    void invoke<SavedTarget | null>("get_saved_target").then(saved => saved && setTarget(saved));
    void refreshLibrary(true); void refreshProcesses();
    const timer = window.setInterval(() => void refreshProcesses(), 2000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listen<ProcessGameAdded>("process-game-added", event => {
      const { services: fresh, serviceId, processName, executable } = event.payload;
      servicesRef.current = fresh;
      setServices(fresh);
      setTarget({ processName, executable });
      setView({ kind: "service", serviceId });
      setSelectedGame(fresh.find(service => service.id === serviceId)?.games.find(game => game.executablePath?.toLowerCase() === executable.toLowerCase()));
      setMessage(`${processName} was saved to the current service.`);
    }).then(unlisten => { if (disposed) unlisten(); else stopListening = unlisten; });
    return () => { disposed = true; stopListening?.(); };
  }, []);
  useEffect(() => {
    if (view.kind !== "service") return;
    void refreshLibrary(false, view.serviceId);
    const timer = window.setInterval(() => void refreshLibrary(false, view.serviceId), 5000);
    return () => window.clearInterval(timer);
  }, [view.kind, view.kind === "service" ? view.serviceId : undefined]);
  useEffect(() => {
    if (!serviceMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest("[data-service-context-menu]")) setServiceMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setServiceMenu(undefined); };
    const close = () => setServiceMenu(undefined);
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [serviceMenu]);
  useEffect(() => {
    if (!servicePendingDeletion) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setServicePendingDeletion(undefined); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [servicePendingDeletion]);
  useEffect(() => {
    const missing = services.flatMap(service => service.games).filter(game => game.needsIconUpgrade && !attemptedOnlineIcons.current.has(game.id));
    if (!missing.length) return;
    missing.forEach(game => attemptedOnlineIcons.current.add(game.id));
    setResolvingIcons(current => [...new Set([...current, ...missing.map(game => game.id)])]);
    void (async () => {
      for (const game of missing) {
        try { applyLibrary(await invoke<GameService[]>("resolve_online_game_icon", { gameId: game.id })); }
        catch { /* A missing online icon must never break the library. */ }
        finally { setResolvingIcons(current => current.filter(id => id !== game.id)); }
      }
    })();
  }, [services]);

  const currentService = view.kind === "service" ? services.find(service => service.id === view.serviceId) : undefined;
  const filteredGames = useMemo(() => (currentService?.games ?? []).filter(game => game.displayName.toLowerCase().includes(query.toLowerCase())), [currentService, query]);
  const activeExecutable = selectedGame?.executablePath ?? target?.executable;
  const activeName = selectedGame?.executableName ?? target?.processName;
  const matches = processes.filter(process => activeExecutable && process.executable ? process.executable.toLowerCase() === activeExecutable.toLowerCase() : !!activeName && process.name.toLowerCase() === activeName.toLowerCase());

  async function browseFolder() { const path = await open({ directory: true, multiple: false, title: "Choose the service's main game library folder" }); if (typeof path === "string") setServicePath(path); }
  async function chooseIcon(title: string) { const path = await open({ multiple: false, title, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "ico"] }] }); return typeof path === "string" ? path : undefined; }
  async function chooseGameIcon(game: LibraryGame) { const path = await chooseIcon(`Choose an icon for ${game.displayName}`); if (!path) return; try { applyLibrary(await invoke<GameService[]>("set_custom_game_icon", { gameId: game.id, sourcePath: path })); } catch (error) { setMessage(String(error)); } }
  async function resetGameIcon(game: LibraryGame) { try { attemptedOnlineIcons.current.delete(game.id); applyLibrary(await invoke<GameService[]>("reset_game_icon", { gameId: game.id })); } catch (error) { setMessage(String(error)); } }
  async function retryGameIcon(game: LibraryGame) { attemptedOnlineIcons.current.add(game.id); setResolvingIcons(current => [...new Set([...current, game.id])]); try { applyLibrary(await invoke<GameService[]>("retry_game_icon", { gameId: game.id })); } catch (error) { setMessage(String(error)); } finally { setResolvingIcons(current => current.filter(id => id !== game.id)); } }
  async function chooseServiceIcon(service: GameService) { const path = await chooseIcon(`Choose an icon for ${service.name}`); if (!path) return; try { applyLibrary(await invoke<GameService[]>("set_custom_service_icon", { serviceId: service.id, sourcePath: path })); } catch (error) { setMessage(String(error)); } }
  async function resetServiceIcon(service: GameService) { try { applyLibrary(await invoke<GameService[]>("reset_service_icon", { serviceId: service.id })); } catch (error) { setMessage(String(error)); } }
  async function addService(event: React.FormEvent) {
    event.preventDefault(); setMessage(undefined);
    try {
      const fresh = await invoke<GameService[]>("add_game_service", { name: serviceName, mainLibraryPath: servicePath });
      servicesRef.current = fresh; setServices(fresh); const added = fresh[fresh.length - 1];
      if (added) { setView({ kind: "service", serviceId: added.id }); setSetupServiceId(added.id); }
      setServiceName(""); setServicePath("");
    } catch (error) { setMessage(String(error)); }
  }
  async function deleteService(service: GameService) {
    setMessage(undefined);
    try {
      const fresh = await invoke<GameService[]>("remove_game_service", { serviceId: service.id });
      servicesRef.current = fresh; setServices(fresh); setSelectedGame(undefined); setView(fresh[0] ? { kind: "service", serviceId: fresh[0].id } : { kind: "empty" });
      setServicePendingDeletion(undefined);
    } catch (error) { setMessage(String(error)); }
  }
  function openServiceMenu(event: React.MouseEvent, serviceId: string) {
    event.preventDefault();
    const width = 184; const height = 48; const margin = 8;
    setServiceMenu({
      serviceId,
      x: Math.max(margin, Math.min(event.clientX, window.innerWidth - width - margin)),
      y: Math.max(margin, Math.min(event.clientY, window.innerHeight - height - margin)),
    });
  }
  async function openProcessPicker(serviceId: string) {
    try { await invoke("open_process_list", { serviceId }); }
    catch (error) { setMessage(String(error)); }
  }

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="mark"><Icon name="gamepad"/></div><span>ModX</span></div>
      <div className="nav-label">MY SERVICES</div>
      <nav className="provider-nav">
        {services.map(service => <button key={service.id} className={view.kind === "service" && view.serviceId === service.id ? "active" : ""} onContextMenu={event => openServiceMenu(event, service.id)} onClick={() => { setServiceMenu(undefined); setView({ kind: "service", serviceId: service.id }); setSelectedGame(undefined); }}><span className="provider-icon">{service.iconDataUrl ? <img src={service.iconDataUrl} alt="" onLoad={event => diagnoseRenderedIcon(event, `service-sidebar:${service.name}`)}/> : <Icon name="games" size={15}/>}</span><span className="nav-name">{service.name}</span><b>{service.games.length}</b></button>)}
        <button className="add-service-nav" onClick={() => { setSetupServiceId(undefined); setAddOpen(true); }}><Icon name="plus"/><span>Add Service</span></button>
      </nav>
      <div className="side-spacer"/><button className="settings"><span>Settings</span></button>
    </aside>
    <main>
      {message && <div className="global-message" onClick={() => setMessage(undefined)}>{message}</div>}
      {view.kind === "service" && <><header className="topbar"><div><span>GAME SERVICE</span><strong>{currentService?.name}</strong></div><div className="top-actions"><button className="add-game-button" onClick={() => currentService && openProcessPicker(currentService.id)}>Add Game</button></div></header>{selectedGame ? <GameWorkspace game={selectedGame} running={matches} resolvingIcon={resolvingIcons.includes(selectedGame.id)} onBack={() => setSelectedGame(undefined)} onLaunch={() => invoke("launch_game", { gameId: selectedGame.id }).catch(error => setMessage(String(error)))} onChooseIcon={() => void chooseGameIcon(selectedGame)} onResetIcon={() => void resetGameIcon(selectedGame)} onRetryIcon={() => void retryGameIcon(selectedGame)}/> : <section className="library-page"><div className="library-heading"><div className="large-provider">{currentService?.iconDataUrl ? <img src={currentService.iconDataUrl} alt="" onLoad={event => diagnoseRenderedIcon(event, `service-header:${currentService.name}`)}/> : <Icon name="games" size={30}/>}</div><div><span>MAIN LIBRARY</span><h1>{currentService?.name}</h1><p title={currentService?.mainLibraryPath}>{currentService?.mainLibraryPath}</p>{currentService && (!currentService.iconDataUrl ? <button className="inline-action" onClick={() => void chooseServiceIcon(currentService)}>Choose service icon</button> : currentService.hasCustomIcon ? <button className="inline-action" onClick={() => void resetServiceIcon(currentService)}>Use automatic service icon</button> : null)}</div></div>{currentService?.scanError && <div className="notice">{currentService.scanError}</div>}<label className="library-search"><Icon name="search"/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search games"/><kbd>{filteredGames.length}</kbd></label><div className="game-grid">{filteredGames.map(game => <button className="game-card" key={game.id} onClick={() => setSelectedGame(game)}><div className={`game-art ${!game.iconDataUrl ? "missing" : ""}`}>{game.iconDataUrl ? <img src={game.iconDataUrl} alt="" onLoad={event => diagnoseRenderedIcon(event, `game-card:${game.displayName}`)}/> : resolvingIcons.includes(game.id) ? <span className="icon-loader" aria-label="Finding icon"/> : <span className="no-icon">No icon<br/>found</span>}</div><span><strong>{game.displayName}</strong><small>{game.executableName ?? "Executable not identified"}</small></span><Icon name="chevron"/></button>)}</div>{!loading && !filteredGames.length && <div className="empty-library"><Icon name="games" size={31}/><h2>{query ? "No matching games" : "No games found"}</h2><p>ModX reads the immediate game folders inside this service's main library location. Use Add Game for an installation stored somewhere else.</p></div>}</section>}</>}
      {view.kind === "empty" && <section className="empty-app"><Icon name="gamepad" size={34}/><h1>Add your first game service</h1><p>Choose the main folder that contains that service's installed game folders.</p><button className="secondary-button" onClick={() => { setSetupServiceId(undefined); setAddOpen(true); }}><Icon name="plus"/> Add Service</button></section>}
    </main>
    {serviceMenu && <div className="service-context-menu" data-service-context-menu role="menu" style={{ left: serviceMenu.x, top: serviceMenu.y }}><button role="menuitem" onClick={() => { const service = services.find(item => item.id === serviceMenu.serviceId); setServiceMenu(undefined); if (service) setServicePendingDeletion(service); }}><Icon name="trash" size={16}/><span>Delete service</span></button></div>}
    {servicePendingDeletion && <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && setServicePendingDeletion(undefined)}><section className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-service-title" aria-describedby="delete-service-description"><div className="confirm-icon"><Icon name="trash" size={20}/></div><h2 id="delete-service-title">Delete service?</h2><p id="delete-service-description">This will remove <strong>{servicePendingDeletion.name}</strong> from ModX. Your installed games will not be deleted.</p><div className="confirm-actions"><button autoFocus className="cancel-confirm" onClick={() => setServicePendingDeletion(undefined)}>Cancel</button><button className="delete-confirm" onClick={() => void deleteService(servicePendingDeletion)}>Delete</button></div></section></div>}
    {addOpen && <div className="modal-backdrop">{setupServiceId ? <section className="small-modal service-complete"><header><div><span>SERVICE ADDED</span><h2>{services.find(service => service.id === setupServiceId)?.name}</h2></div><button type="button" onClick={() => { setAddOpen(false); setSetupServiceId(undefined); }}><Icon name="close"/></button></header><div className="setup-summary"><Icon name="check"/><div><strong>Main library added</strong><small>{services.find(service => service.id === setupServiceId)?.mainLibraryPath}</small></div></div><p>Games in the main library have been scanned. If this service has a game installed somewhere else, launch it and add its running process now.</p><button className="secondary-button setup-action" onClick={() => { const id = setupServiceId; setAddOpen(false); setSetupServiceId(undefined); openProcessPicker(id); }}><Icon name="process"/> Add an out-of-library game</button><button className="finish-button" onClick={() => { setAddOpen(false); setSetupServiceId(undefined); }}>Finish</button></section> : <form className="small-modal" onSubmit={event => void addService(event)}><header><div><span>NEW SERVICE</span><h2>Add Service</h2></div><button type="button" onClick={() => setAddOpen(false)}><Icon name="close"/></button></header><label>Service name<input autoFocus value={serviceName} onChange={event => setServiceName(event.target.value)} placeholder="Example: My Main Launcher" maxLength={80}/></label><label>Main game library location<div className="path-row"><input value={servicePath} onChange={event => setServicePath(event.target.value)} placeholder="D:\Games\MainLibrary"/><button type="button" onClick={() => void browseFolder()}><Icon name="folder"/> Browse</button></div><small>Select the folder that directly contains this service's individual game folders.</small></label><button className="secondary-button modal-submit" disabled={!serviceName.trim() || !servicePath.trim()}>Add Service</button></form>}</div>}
  </div>;
}

function GameWorkspace({ game, resolvingIcon, onBack, onLaunch }: { game: LibraryGame; running: RunningProcess[]; resolvingIcon: boolean; onBack: () => void; onLaunch: () => void; onChooseIcon: () => void; onResetIcon: () => void; onRetryIcon: () => void }) {
  return <div className="workspace"><button className="back-button" onClick={onBack}>← Back to games</button><section className="target-card"><div className={`process-logo ${!game.iconDataUrl ? "missing" : ""}`}>{game.iconDataUrl ? <img src={game.iconDataUrl} alt="" onLoad={event => diagnoseRenderedIcon(event, `game-detail:${game.displayName}`)}/> : resolvingIcon ? <span className="icon-loader" aria-label="Finding icon"/> : <span className="no-icon">No icon<br/>found</span>}</div><div className="target-name"><span>GAME</span><h1>{game.displayName}</h1><p title={game.installPath}>{game.installPath}</p></div>{game.executablePath && <button className="launch-button" onClick={onLaunch}>Launch</button>}</section><div className="workspace-grid"><section className="tables-card"><header><div><h2>Available cheat tables</h2><p>Community tables associated with this game will appear here.</p></div></header><div className="no-tables"><div>CT</div><h3>No compatible table found</h3><p>The ModX catalogue has not returned a table for this game yet.</p></div></section></div></div>;
}
