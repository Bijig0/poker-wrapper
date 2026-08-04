//! WASM bindings around postflop-solver.
//!
//! Exposes a single entry point, `solve_river`, that builds a heads-up river
//! game tree containing an arbitrary (user-chosen) bet size, solves it to
//! equilibrium with Discounted CFR, and returns hero's GTO response as JSON.
//!
//! Line modelled: HERO (OOP) checks -> VILLAIN (IP) bets `bet_pct`% of pot ->
//! HERO faces the bet (call / fold). The returned strategy is the *averaged*
//! equilibrium strategy (game.strategy()), with per-hand EVs and weights.

use postflop_solver::*;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct SolveResult {
    exploitability: f32,
    bet_chips: i32,
    villain_bet_freq: f32,        // how often villain actually bets (on-path check)
    actions: Vec<String>,         // hero's actions, e.g. ["Fold","Call"]
    hands: Vec<String>,           // hero's private hands, e.g. ["AsKh", ...]
    strategy: Vec<Vec<f32>>,      // per hand: freq per action (aligned with `actions`)
    weights: Vec<f32>,            // normalized combo weight per hand
    ev: Vec<f32>,                 // per-hand EV (chips)
}

/// Split a board string like "Qs Jh 2h 8c 3d" / "QsJh2h8c3d" into 5 cards.
fn clean_board(board: &str) -> String {
    board.chars().filter(|c| c.is_alphanumeric()).collect()
}

// ---- range-derivation demo -------------------------------------------------

#[derive(Serialize)]
struct HandRow {
    hand: String,
    weight: f32, // share of total range weight at this node (0..1)
    equity: f32, // all-in equity vs villain's range AT THIS NODE (0..1)
}

#[derive(Serialize)]
struct StreetSnapshot {
    label: String,
    n_combos: usize, // combos with meaningful weight (range width proxy)
    avg_equity: f32, // combo-weighted average equity of hero's range
    top: Vec<HandRow>,
}

#[derive(Serialize)]
struct DeriveResult {
    exploitability: f32,
    streets: Vec<StreetSnapshot>,
}

/// Read hero's reach-weighted range at the CURRENT node straight out of the solve.
/// `normalized_weights` IS the range: hands that rarely reach this node ~0.
fn snapshot(game: &mut PostFlopGame, player: usize, label: &str) -> StreetSnapshot {
    game.cache_normalized_weights();
    let hands = holes_to_strings(game.private_cards(player)).unwrap();
    let w = game.normalized_weights(player).to_vec();
    let eq = game.equity(player);
    let wsum: f32 = w.iter().sum();

    let mut avg_equity = 0.0f32;
    for i in 0..hands.len() {
        avg_equity += w[i] * eq[i];
    }
    avg_equity = if wsum > 0.0 { avg_equity / wsum } else { 0.0 };

    let maxw = w.iter().cloned().fold(0.0f32, f32::max);
    let eps = maxw * 0.02;
    let n_combos = w.iter().filter(|&&x| x > eps).count();

    let mut idx: Vec<usize> = (0..hands.len()).collect();
    idx.sort_by(|&a, &b| w[b].partial_cmp(&w[a]).unwrap());
    let mut top = Vec::new();
    for &i in idx.iter().take(12) {
        if w[i] <= eps {
            break;
        }
        top.push(HandRow {
            hand: hands[i].clone(),
            weight: if wsum > 0.0 { w[i] / wsum } else { 0.0 },
            equity: eq[i],
        });
    }

    StreetSnapshot {
        label: label.to_string(),
        n_combos,
        avg_equity,
        top,
    }
}

/// Play the first available action whose debug string starts with `prefix`.
fn play_named(game: &mut PostFlopGame, prefix: &str) {
    let actions: Vec<String> = game
        .available_actions()
        .iter()
        .map(|a| format!("{:?}", a))
        .collect();
    let idx = actions
        .iter()
        .position(|s| s.starts_with(prefix))
        .unwrap_or_else(|| panic!("action '{}' not available; have {:?}", prefix, actions));
    game.play(idx);
}

/// Solve the FULL flop (turn/river undealt) from real preflop ranges, then walk
/// a fixed line — flop check→bet→CALL, turn check→check, river — reading hero's
/// range out of the solver at the start of each street. Proves the turn/river
/// ranges are DERIVED by the solve, not supplied as input.
#[wasm_bindgen]
pub fn derive_ranges(
    flop: &str,
    turn: &str,
    river: &str,
    oop_range: &str,
    ip_range: &str,
    pot: i32,
    stack: i32,
    bet_sizes: &str,
    raise_sizes: &str,
    max_iter: u32,
    target_pct: f64,
) -> String {
    console_error_panic_hook::set_once();
    let fb = clean_board(flop);

    let card_config = CardConfig {
        range: [oop_range.parse().unwrap(), ip_range.parse().unwrap()],
        flop: flop_from_str(&fb[0..6]).unwrap(),
        turn: NOT_DEALT, // full flop solve -> every turn & river node exists
        river: NOT_DEALT,
    };

    let bets = BetSizeOptions::try_from((bet_sizes, raise_sizes)).unwrap();
    let tree_config = TreeConfig {
        initial_state: BoardState::Flop,
        starting_pot: pot,
        effective_stack: stack,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [bets.clone(), bets.clone()],
        turn_bet_sizes: [bets.clone(), bets.clone()],
        river_bet_sizes: [bets.clone(), bets.clone()],
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 1.5,
        force_allin_threshold: 0.15,
        merging_threshold: 0.1,
    };

    let action_tree = ActionTree::new(tree_config).unwrap();
    let mut game = PostFlopGame::with_config(card_config, action_tree).unwrap();
    game.allocate_memory(false);

    let target = pot as f32 * (target_pct as f32);
    let exploitability = solve(&mut game, max_iter, target, false);

    let turn_card = card_from_str(&clean_board(turn)[0..2]).unwrap();
    let river_card = card_from_str(&clean_board(river)[0..2]).unwrap();

    let mut streets = Vec::new();

    // Hero = OOP (player 0), who acts first on every street.
    streets.push(snapshot(
        &mut game,
        0,
        &format!("Flop  {}  — range entering the flop", flop.trim()),
    ));

    // flop: OOP check -> IP bet -> OOP call
    play_named(&mut game, "Check");
    play_named(&mut game, "Bet");
    play_named(&mut game, "Call");

    game.play(turn_card as usize); // deal turn
    streets.push(snapshot(
        &mut game,
        0,
        &format!("Turn  {}  — after flop check-bet-CALL (hero now capped)", turn.trim()),
    ));

    // turn: check-check
    play_named(&mut game, "Check");
    play_named(&mut game, "Check");

    game.play(river_card as usize); // deal river
    streets.push(snapshot(
        &mut game,
        0,
        &format!("River {}  — after turn check-check", river.trim()),
    ));

    serde_json::to_string(&DeriveResult {
        exploitability,
        streets,
    })
    .unwrap()
}

#[derive(Serialize)]
struct SpotResult {
    exploitability: f32,
    node_player: usize,       // 0 = OOP, 1 = IP (whose strategy this is)
    actions: Vec<String>,
    hands: Vec<String>,
    strategy: Vec<Vec<f32>>,
    weights: Vec<f32>,
    ev: Vec<f32>,             // per-hand node EV (chips)
    equity: Vec<f32>,         // per-hand equity (0..1)
}

/// Solve a heads-up postflop spot from the start of `initial_street` and return
/// the GTO strategy at hero's first decision node on that street.
///
/// `hero_pos`: "oop" (acts first -> root strategy) or "ip" (after OOP checks).
/// `bet_sizes`/`raise_sizes`: postflop-solver size strings, applied to every
/// street for both players (e.g. "33%, 75%, a" and "60%").
#[wasm_bindgen]
pub fn solve_spot(
    initial_street: &str,
    board: &str,
    oop_range: &str,
    ip_range: &str,
    pot: i32,
    stack: i32,
    bet_sizes: &str,
    raise_sizes: &str,
    hero_pos: &str,
    max_iter: u32,
    target_pct: f64,
) -> String {
    console_error_panic_hook::set_once();
    let b = clean_board(board);
    let (flop, turn, river, state) = match initial_street {
        "flop" => (
            flop_from_str(&b[0..6]).unwrap(),
            NOT_DEALT,
            NOT_DEALT,
            BoardState::Flop,
        ),
        "turn" => (
            flop_from_str(&b[0..6]).unwrap(),
            card_from_str(&b[6..8]).unwrap(),
            NOT_DEALT,
            BoardState::Turn,
        ),
        _ => (
            flop_from_str(&b[0..6]).unwrap(),
            card_from_str(&b[6..8]).unwrap(),
            card_from_str(&b[8..10]).unwrap(),
            BoardState::River,
        ),
    };

    let card_config = CardConfig {
        range: [oop_range.parse().unwrap(), ip_range.parse().unwrap()],
        flop,
        turn,
        river,
    };

    let bets = BetSizeOptions::try_from((bet_sizes, raise_sizes)).unwrap();
    let tree_config = TreeConfig {
        initial_state: state,
        starting_pot: pot,
        effective_stack: stack,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [bets.clone(), bets.clone()],
        turn_bet_sizes: [bets.clone(), bets.clone()],
        river_bet_sizes: [bets.clone(), bets.clone()],
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 1.5,
        force_allin_threshold: 0.15,
        merging_threshold: 0.1,
    };

    let action_tree = ActionTree::new(tree_config).unwrap();
    let mut game = PostFlopGame::with_config(card_config, action_tree).unwrap();
    game.allocate_memory(false);

    let target = pot as f32 * (target_pct as f32);
    let exploitability = solve(&mut game, max_iter, target, false);

    // Navigate to hero's first decision node. Root actor is OOP (player 0).
    // For an IP hero, advance past OOP's check to reach the IP node.
    let mut node_player = 0usize;
    if hero_pos == "ip" {
        let dbg: Vec<String> = game
            .available_actions()
            .iter()
            .map(|a| format!("{:?}", a))
            .collect();
        if let Some(ci) = dbg.iter().position(|s| s == "Check") {
            game.play(ci);
            node_player = 1;
        }
    }

    game.cache_normalized_weights();
    let actions: Vec<String> = game
        .available_actions()
        .iter()
        .map(|a| format!("{:?}", a))
        .collect();
    let hands = holes_to_strings(game.private_cards(node_player)).unwrap();
    let n = hands.len();
    let na = actions.len();
    let flat = game.strategy();
    let ev = game.expected_values(node_player);
    let weights = game.normalized_weights(node_player).to_vec();
    let equity = game.equity(node_player);

    let mut strategy = Vec::with_capacity(n);
    for h in 0..n {
        let mut row = Vec::with_capacity(na);
        for a in 0..na {
            row.push(flat[a * n + h]);
        }
        strategy.push(row);
    }

    serde_json::to_string(&SpotResult {
        exploitability,
        node_player,
        actions,
        hands,
        strategy,
        weights,
        ev,
        equity,
    })
    .unwrap()
}

#[wasm_bindgen]
pub fn solve_river(
    board: &str,
    oop_range: &str,
    ip_range: &str,
    pot: i32,
    stack: i32,
    bet_pct: f64,
) -> String {
    let b = clean_board(board);

    let card_config = CardConfig {
        range: [oop_range.parse().unwrap(), ip_range.parse().unwrap()],
        flop: flop_from_str(&b[0..6]).unwrap(),
        turn: card_from_str(&b[6..8]).unwrap(),
        river: card_from_str(&b[8..10]).unwrap(),
    };

    // hero (OOP) gets no bet options -> check / call / fold only.
    let empty = BetSizeOptions::try_from(("", "")).unwrap();
    // villain (IP) may only check or make THE NOVEL bet the user typed.
    let villain_bet = BetSizeOptions::try_from((format!("{}%", bet_pct).as_str(), "")).unwrap();

    let tree_config = TreeConfig {
        initial_state: BoardState::River,
        starting_pot: pot,
        effective_stack: stack,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [empty.clone(), empty.clone()],
        turn_bet_sizes: [empty.clone(), empty.clone()],
        river_bet_sizes: [empty.clone(), villain_bet], // [OOP hero, IP villain]
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 0.0,   // never auto-append an all-in node
        force_allin_threshold: 0.0,
        merging_threshold: 0.0,
    };

    let action_tree = ActionTree::new(tree_config).unwrap();
    let mut game = PostFlopGame::with_config(card_config, action_tree).unwrap();
    game.allocate_memory(false);

    let target = pot as f32 * 0.002; // 0.2% of pot
    let exploitability = solve(&mut game, 2000, target, false);

    // --- navigate: HERO checks -> VILLAIN node -> capture bet freq -> bet -> HERO faces ---
    game.play(0); // hero checks (only action available)

    let ip_dbg: Vec<String> = game
        .available_actions()
        .iter()
        .map(|a| format!("{:?}", a))
        .collect();
    let bet_idx = ip_dbg
        .iter()
        .position(|s| s.starts_with("Bet"))
        .expect("villain has no bet action (bet off-path?)");
    let bet_chips: i32 = ip_dbg[bet_idx]
        .trim_start_matches("Bet(")
        .trim_end_matches(')')
        .parse()
        .unwrap_or(0);

    // villain's betting frequency at this node (weighted by combos)
    game.cache_normalized_weights();
    let ip_w = game.normalized_weights(1).to_vec();
    let n_ip = game.private_cards(1).len();
    let ip_strat = game.strategy();
    let w_sum: f32 = ip_w.iter().sum();
    let mut bet_w = 0.0f32;
    for h in 0..n_ip {
        bet_w += ip_strat[bet_idx * n_ip + h] * ip_w[h];
    }
    let villain_bet_freq = if w_sum > 0.0 { bet_w / w_sum } else { 0.0 };

    game.play(bet_idx); // villain bets

    // hero now faces the bet
    game.cache_normalized_weights();
    let actions: Vec<String> = game
        .available_actions()
        .iter()
        .map(|a| format!("{:?}", a))
        .collect();
    let hands = holes_to_strings(game.private_cards(0)).unwrap();
    let n = hands.len();
    let na = actions.len();
    let flat = game.strategy();
    let ev = game.expected_values(0);
    let weights = game.normalized_weights(0).to_vec();

    let mut strategy = Vec::with_capacity(n);
    for h in 0..n {
        let mut row = Vec::with_capacity(na);
        for a in 0..na {
            row.push(flat[a * n + h]);
        }
        strategy.push(row);
    }

    let result = SolveResult {
        exploitability,
        bet_chips,
        villain_bet_freq,
        actions,
        hands,
        strategy,
        weights,
        ev,
    };
    serde_json::to_string(&result).unwrap()
}
