// Thin loader: preserve the verified client module unchanged and add fast approval UI.
export * from './cloudflare-client-original.js';
import './fast-approval-ui.js';
