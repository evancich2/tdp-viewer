// Browser-side PWA glue: service worker registration and updates, the install prompt, and files
// the OS hands to the installed app. Everything degrades to a no-op where unsupported.

/**
 * Registers the service worker (production builds only). `onUpdateReady` is called when a new,
 * fully verified version is waiting; calling the function it receives activates it and reloads.
 */
export function registerServiceWorker(onUpdateReady: (apply: () => void) => void): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Reload only for an update the user accepted, not on first install.
    if (hadController && !reloading) {
      reloading = true;
      location.reload();
    }
  });
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((reg) => {
    const offer = (worker: ServiceWorker | null) => {
      if (worker && navigator.serviceWorker.controller) onUpdateReady(() => worker.postMessage("skip-waiting"));
    };
    offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      worker?.addEventListener("statechange", () => worker.state === "installed" && offer(worker));
    });
  });
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Calls `onAvailable` with a function that shows the browser's install dialog, when installing is possible. */
export function onInstallAvailable(onAvailable: (install: (() => Promise<void>) | null) => void): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    const event = e as BeforeInstallPromptEvent;
    onAvailable(async () => {
      await event.prompt();
      await event.userChoice;
      onAvailable(null);
    });
  });
  window.addEventListener("appinstalled", () => onAvailable(null));
}

interface LaunchParams {
  files: FileSystemFileHandle[];
}

/** Delivers .tdp files opened from the OS (File Handling API, Chromium browsers). */
export function onLaunchFiles(handle: (file: File) => void): void {
  const queue = (window as unknown as { launchQueue?: { setConsumer(c: (p: LaunchParams) => void): void } }).launchQueue;
  queue?.setConsumer(async (params) => {
    for (const fh of params.files) handle(await fh.getFile());
  });
}
