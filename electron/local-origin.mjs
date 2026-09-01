// Origin gate for IPC handlers that touch this machine directly (screen
// capture, microphone, installing an update). Safe when the window shows
// our own local harness or a bundled file:// page; unsafe when it shows an
// arbitrary remote host (C2 remote mode) — that page, or a MITM on the
// plain http:// that normalizeRemoteUrl still accepts, must not be able to
// trigger ogb.screenFrame()/speechStart()/updater.download()/install() just
// by being loaded in the window.
export function isLocalSender(event) {
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === "file:" || url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}
