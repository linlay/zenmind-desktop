import { contextBridge } from "electron";
import { disableLocalDocumentNetworkTransports } from "../shared/local-document-network-policy";

// Opaque-origin child frames can start without a CDP navigation pause. A
// sandbox preload protects their first script and exports no host capability.
contextBridge.executeInMainWorld({ func: disableLocalDocumentNetworkTransports });
