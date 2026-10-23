// Plays games with the app's own engine and bots (compiled from ~/code/fivehundred) and
// writes what happened as JSON lines, for tests/parity/parity.js to replay on the web
// version. Every bot is an Expert with a random style. Each decision gets its own seeded
// generator (SplitMix64, seed = the decision's number), so the web bots can be given the
// very same random numbers. Every deal is written out too (throw-ins and redeals shuffle
// inside the engine).
//   parity GAMES [FIRST_SEED]
import Foundation

struct SplitMix64: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}

let args = CommandLine.arguments.dropFirst().map { Int($0) ?? 0 }
let games = args.first ?? 10
let firstSeed = args.count > 1 ? args[1] : 2026
var rng = SplitMix64(state: UInt64(firstSeed))
var decision = UInt64(firstSeed) * 1_000_000

func id(_ c: Card) -> Int { c.id }
func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}
func encode(_ move: FiveHundredGame.Move) -> [String: Any] {
    switch move {
    case .bid(let bid): return ["type": "bid", "tricks": bid.tricks, "trump": bid.trump.order]
    case .pass: return ["type": "pass"]
    case .discard(let cards): return ["type": "discard", "cards": cards.map(id)]
    case .play(let card, let suit): return ["type": "play", "card": id(card), "jokerSuit": suit.map { $0.rawValue } ?? NSNull()]
    }
}
func emitDeal(_ game: FiveHundredGame) {
    emit(["kind": "deal", "dealer": game.dealer, "hands": game.hands.map { $0.map(id) }, "kitty": game.kitty.map(id)])
}

for number in 0..<games {
    var game = FiveHundredGame(dealer: Int.random(in: 0...3, using: &rng), deck: Card.fullDeck.shuffled(using: &rng))
    let styles = (0..<4).map { _ in BotStyle.allCases.randomElement(using: &rng)! }
    emit(["kind": "game", "number": number, "styles": styles.map(\.rawValue)])
    emitDeal(game)
    while game.phase != .gameOver {
        if game.phase == .handOver {
            try! game.nextHand(deck: Card.fullDeck.shuffled(using: &rng))
            emitDeal(game)
            continue
        }
        let seat = game.turn
        decision += 1
        var r = SplitMix64(state: decision)
        let move = Bot(style: styles[seat], skill: .expert).move(game, as: seat, using: &r)
        emit(["kind": "move", "seat": seat, "seed": String(decision), "move": encode(move)])
        try! game.apply(move, by: seat)
        if game.phase == .bidding && game.calls.isEmpty { emitDeal(game) }       // Everyone passed.
        if let result = game.result, game.phase != .bidding, game.trick.isEmpty, game.hands.allSatisfy(\.isEmpty) {
            emit(["kind": "result", "made": result.made, "points": result.points, "tricks": result.tricks,
                  "scores": game.scores, "phase": game.phase.rawValue, "winner": game.winner ?? NSNull()])
        }
    }
}
