// Items phase 4 - QR tags and phone scan (Neil, 11/02/2026). The whole
// integration surface; everything else in this folder is internal.
//
// MOUNT (once, inside the Items view - today views/InventoryManagement.jsx):
//   <ItemScanHost activeSub onSubChange userEmail userName isManager toast renderItem? />
//     Opens the item an "item/<id>" sub names (a QR tag, a shared link,
//     openItemById), the scanner and the tag sheet. `renderItem` lets the
//     item record sheet draw a found item: renderItem({ item, view, close,
//     runAction }) where view = itemActionsFor(...) ({ state, actions,
//     checkout, assignment }) and runAction(key) runs one of view.actions
//     through the existing Items flows. Loading and "no access" stay here.
//
// BUTTONS:
//   <ItemScanButton />             - "Scan" (phones always; computers with a camera)
//   printItemTags(items)           - from a selection: opens the tag sheet
//
// EVENTS (window CustomEvents, for code that cannot import this folder):
//   nexus:items-scan               - open the scanner
//   nexus:items-print-tags         - detail { items: [{ id, name?, serialNumber? }] }
//   nexus:navigate { view: 'inventory', sub: 'item/<id>' } - open one item
//
// ROUTE: /itemmanagement/item/<id> (lib/routes.js itemLinkSub -> sub "item/<id>";
//   /inventory/item/<id> and a bell's "item:<id>" sub land the same).
// SERVER: GET /items/by-code?code= (walled, 404 outside the caller's
//   companies), POST /items/tags { ids } (items admins) - routers/items.py.
// CHUNKS: ScannerSheet and TagSheet are lazy; jsqr (vendor-jsqr) loads only
//   without BarcodeDetector, qrcode (vendor-qr) only with the tag sheet.
//   scripts/check-bundle-size.mjs fails if either reaches first paint.

export { ItemScanHost } from './ItemScanHost';
export { ItemScanButton } from './ItemScanButton';
export { openItemById, openItemScanner, printItemTags, ITEM_SCAN_EVENT, ITEM_TAGS_EVENT } from './events';
export { itemSub, itemPath, itemUrl, parseItemSub, parseScannedCode } from './itemLink';
export { itemActionsFor } from './itemActions';
