// scratch: print one baked 6-max chart node (id, line)
import { nodeGetter } from "../services/hrc6max";
const [id, line] = [process.argv[2]!, process.argv[3] ?? ""];
const n: any = await nodeGetter(id)(line);
if (!n || n === "unreachable") { console.log(n); process.exit(0); }
console.log(JSON.stringify({ pos: n.pos, terminal: n.terminal, pruned: n.pruned, actions: n.actions, ncells: n.cells.length, cell0: n.cells[0], keys: Object.keys(n) }, null, 1));
