/**
 * Where things are. The TypeScript wrapper keeps the Python wrapper's files: its pages (panel.html, setup.html…),
 * formats.json, assets/, and its data (data/hands.db, data/sessions.sqlite, data/profiles.json, debug/) all stay in
 * ignition-study-wrapper/, so hand history, sessions and profiles carry straight across the cut-over.
 * WRAPPER_ROOT overrides it (tests point it at a temp copy).
 */
import { resolve, join } from "node:path";

export const REPO = resolve(import.meta.dir, "../../../..");

export function paths() {
  const root = process.env.WRAPPER_ROOT ? resolve(process.env.WRAPPER_ROOT) : join(REPO, "ignition-study-wrapper");
  const data = process.env.WRAPPER_DATA_DIR ? resolve(process.env.WRAPPER_DATA_DIR) : join(root, "data");
  return { repo: REPO, root, data, debug: join(root, "debug"), assets: join(root, "assets") };
}
