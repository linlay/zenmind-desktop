/** Self-contained: Electron serializes this function into fresh page realms. */
export function disableLocalDocumentNetworkTransports() {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCIceTransport", "RTCDtlsTransport", "RTCSctpTransport", "WebTransport"]) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
  }
}
