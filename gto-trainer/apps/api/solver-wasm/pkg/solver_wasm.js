/* @ts-self-types="./solver_wasm.d.ts" */

/**
 * Solve the FULL flop (turn/river undealt) from real preflop ranges, then walk
 * a fixed line — flop check→bet→CALL, turn check→check, river — reading hero's
 * range out of the solver at the start of each street. Proves the turn/river
 * ranges are DERIVED by the solve, not supplied as input.
 * @param {string} flop
 * @param {string} turn
 * @param {string} river
 * @param {string} oop_range
 * @param {string} ip_range
 * @param {number} pot
 * @param {number} stack
 * @param {string} bet_sizes
 * @param {string} raise_sizes
 * @param {number} max_iter
 * @param {number} target_pct
 * @returns {string}
 */
function derive_ranges(flop, turn, river, oop_range, ip_range, pot, stack, bet_sizes, raise_sizes, max_iter, target_pct) {
    let deferred8_0;
    let deferred8_1;
    try {
        const ptr0 = passStringToWasm0(flop, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(turn, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(river, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(oop_range, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(ip_range, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(bet_sizes, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(raise_sizes, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.derive_ranges(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, pot, stack, ptr5, len5, ptr6, len6, max_iter, target_pct);
        deferred8_0 = ret[0];
        deferred8_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred8_0, deferred8_1, 1);
    }
}
exports.derive_ranges = derive_ranges;

/**
 * @param {string} board
 * @param {string} oop_range
 * @param {string} ip_range
 * @param {number} pot
 * @param {number} stack
 * @param {number} bet_pct
 * @returns {string}
 */
function solve_river(board, oop_range, ip_range, pot, stack, bet_pct) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(board, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(oop_range, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(ip_range, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.solve_river(ptr0, len0, ptr1, len1, ptr2, len2, pot, stack, bet_pct);
        deferred4_0 = ret[0];
        deferred4_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}
exports.solve_river = solve_river;

/**
 * Solve a heads-up postflop spot from the start of `initial_street` and return
 * the GTO strategy at hero's first decision node on that street.
 *
 * `hero_pos`: "oop" (acts first -> root strategy) or "ip" (after OOP checks).
 * `bet_sizes`/`raise_sizes`: postflop-solver size strings, applied to every
 * street for both players (e.g. "33%, 75%, a" and "60%").
 * @param {string} initial_street
 * @param {string} board
 * @param {string} oop_range
 * @param {string} ip_range
 * @param {number} pot
 * @param {number} stack
 * @param {string} bet_sizes
 * @param {string} raise_sizes
 * @param {string} hero_pos
 * @param {number} max_iter
 * @param {number} target_pct
 * @returns {string}
 */
function solve_spot(initial_street, board, oop_range, ip_range, pot, stack, bet_sizes, raise_sizes, hero_pos, max_iter, target_pct) {
    let deferred8_0;
    let deferred8_1;
    try {
        const ptr0 = passStringToWasm0(initial_street, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(board, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(oop_range, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(ip_range, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(bet_sizes, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(raise_sizes, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(hero_pos, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.solve_spot(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, pot, stack, ptr4, len4, ptr5, len5, ptr6, len6, max_iter, target_pct);
        deferred8_0 = ret[0];
        deferred8_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred8_0, deferred8_1, 1);
    }
}
exports.solve_spot = solve_spot;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./solver_wasm_bg.js": import0,
    };
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/solver_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
