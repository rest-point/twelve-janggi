using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.MemoryMappedFiles;

// Offline solver for the fixed eight-piece inventory in strict-v2.
// Keys always describe the side to move as side 0, with its camp on the left.
static class FullTablebase
{
    const int King = 1, Rook = 2, Bishop = 3, Pawn = 4, Hen = 5;
    const int RankBase = 256, BoardBits = 48, PairCount = 74, Stride = 11878227;
    const ulong BoardMask = (1UL << BoardBits) - 1;
    const string Magic = "TJFULL01";
    static readonly int[] Pop = new int[4096], First = new int[4096], Pairs = new int[144];
    static readonly int[] PawnCount = new int[11], BishopCount = new int[11];
    static readonly int[,] Attack = new int[16, 12], Origin = new int[16, 12];
    static readonly ulong[] Groups = new ulong[4096], Flips = new ulong[4096];
    static readonly short[][] Status = new short[PairCount][];

    static FullTablebase()
    {
        for (int i = 1; i < 4096; i++) {
            Pop[i] = Pop[i >> 1] + (i & 1);
            First[i] = (i & 1) != 0 ? 0 : First[i >> 1] + 1;
        }
        int pair = 0;
        for (int a = 0; a < 12; a++) for (int b = 0; b < 12; b++)
            Pairs[a * 12 + b] = Math.Abs(a % 4 - b % 4) > 1 || Math.Abs(a / 4 - b / 4) > 1 ? pair++ : -1;
        for (int n = 0; n <= 10; n++) {
            PawnCount[n] = 3 + 8 * n + 16 * Choose2(n);
            BishopCount[n] = 3 * PawnCount[n] + (n >= 1 ? 4 * n * PawnCount[n - 1] : 0)
                + (n >= 2 ? 4 * Choose2(n) * PawnCount[n - 2] : 0);
        }
        if (pair != PairCount || 3 * BishopCount[10] + 40 * BishopCount[9] + 180 * BishopCount[8] != Stride)
            throw new InvalidOperationException("Dense index dimensions disagree");
        for (int chunk = 0; chunk < 4096; chunk++) for (int i = 0; i < 3; i++) {
            int piece = (chunk >> (4 * i)) & 15;
            if (piece == 0) continue;
            int kind = piece & 7, group = kind == King ? 3 : kind == Hen ? 2 : kind - 2;
            Groups[chunk] |= 1UL << (12 * group + i);
            Flips[chunk] |= (ulong)(piece ^ 8) << (4 * (2 - i));
        }
        for (int side = 0; side < 2; side++) for (int kind = King; kind <= Hen; kind++) {
            int piece = kind + 8 * side;
            for (int from = 0; from < 12; from++) for (int to = 0; to < 12; to++) {
                int dx = to % 4 - from % 4, dy = to / 4 - from / 4;
                int x = Math.Abs(dx), y = Math.Abs(dy), forward = side == 0 ? 1 : -1;
                bool ortho = x + y == 1, diag = x == 1 && y == 1;
                bool allowed = kind == King ? ortho || diag : kind == Rook ? ortho : kind == Bishop ? diag
                    : kind == Pawn ? dx == forward && y == 0 : ortho || (dx == forward && y == 1);
                if (!allowed) continue;
                Attack[piece, from] |= 1 << to;
                Origin[piece, to] |= 1 << from;
            }
        }
    }

    static int Choose2(int n) { return n * (n - 1) / 2; }
    static int Piece(ulong key, int sq) { return (int)(key >> (4 * sq)) & 15; }
    static ulong Put(ulong key, int sq, int piece)
    {
        int shift = 4 * sq;
        return (key & ~(15UL << shift)) | ((ulong)piece << shift);
    }
    static ulong HandUnit(int side, int kind) { return 1UL << (BoardBits + 6 * side + 2 * (kind - Rook)); }
    static int Hand(ulong key, int side, int kind) { return (int)(key >> (BoardBits + 6 * side + 2 * (kind - Rook))) & 3; }
    static ulong Flip(ulong key)
    {
        return (Flips[key & 4095] << 36) | (Flips[(key >> 12) & 4095] << 24)
            | (Flips[(key >> 24) & 4095] << 12) | Flips[(key >> 36) & 4095]
            | ((key & (63UL << 48)) << 6) | ((key & (63UL << 54)) >> 6);
    }
    static int GroupOrdinal(ulong key, int mask, int free, int kind)
    {
        if (mask == 0) return Hand(key, 0, kind);
        int a = First[mask], code = Piece(key, a), variant = code >> 3;
        int variants = kind == Pawn ? 4 : 2;
        if (kind == Pawn) variant = 2 * variant + ((code & 7) == Hen ? 1 : 0);
        int ai = Pop[free & ((1 << a) - 1)];
        int rest = mask & (mask - 1);
        if (rest == 0) return (ai * variants + variant) * 2 + Hand(key, 0, kind);
        int b = First[rest], other = Piece(key, b), bi = Pop[free & ((1 << b) - 1)];
        int bv = kind == Pawn ? 2 * (other >> 3) + ((other & 7) == Hen ? 1 : 0) : other >> 3;
        return ((Choose2(bi) + ai) * variants + variant) * variants + bv;
    }
    static int Index(ulong key, out int pair)
    {
        ulong masks = Groups[key & 4095] | (Groups[(key >> 12) & 4095] << 3)
            | (Groups[(key >> 24) & 4095] << 6) | (Groups[(key >> 36) & 4095] << 9);
        int kings = (int)(masks >> 36), a = First[kings], b = First[kings & (kings - 1)];
        pair = Piece(key, a) == King ? Pairs[a * 12 + b] : Pairs[b * 12 + a];
        if (pair < 0) return -1;
        int free = 4095 ^ kings, rook = (int)masks & 4095;
        int n = Pop[rook], rank = GroupOrdinal(key, rook, free, Rook) * BishopCount[10 - n];
        if (n >= 1) rank += 3 * BishopCount[10];
        if (n == 2) rank += 40 * BishopCount[9];
        free ^= rook;
        int m = 10 - n, bishop = (int)(masks >> 12) & 4095, count = Pop[bishop];
        rank += GroupOrdinal(key, bishop, free, Bishop) * PawnCount[m - count];
        if (count >= 1) rank += 3 * PawnCount[m];
        if (count == 2) rank += 4 * m * PawnCount[m - 1];
        free ^= bishop;
        m -= count;
        int pawn = (int)(masks >> 24) & 4095;
        rank += GroupOrdinal(key, pawn, free, Pawn);
        if (pawn != 0) rank += 3;
        if (Pop[pawn] == 2) rank += 8 * m;
        return rank;
    }

    static bool Attacked(ulong key, int king, int attacker)
    {
        int target = 1 << king;
        for (int from = 0; from < 12; from++) {
            int piece = Piece(key, from);
            if (piece != 0 && (piece >> 3) == attacker && (Attack[piece, from] & target) != 0) return true;
        }
        return false;
    }
    static int Generate(ulong key, ulong[] children, int[] moves, out int terminal)
    {
        int king = -1, enemyKing = -1, empty = 0;
        for (int sq = 0; sq < 12; sq++) {
            int piece = Piece(key, sq);
            if (piece == 0) empty |= 1 << sq;
            else if (piece == King) king = sq;
            else if (piece == King + 8) enemyKing = sq;
        }
        terminal = king % 4 == 3 && !Attacked(key, king, 1) ? 1 : enemyKing % 4 == 0 && !Attacked(key, enemyKing, 0) ? -1 : 0;
        if (terminal != 0) return 0;
        int count = 0;
        for (int from = 0; from < 12; from++) {
            int piece = Piece(key, from);
            if (piece == 0 || piece >= 8) continue;
            int destinations = Attack[piece, from];
            while (destinations != 0) {
                int to = First[destinations]; destinations &= destinations - 1;
                int captured = Piece(key, to);
                if (captured != 0 && captured <= 9) continue;
                int moved = piece == Pawn && to % 4 == 3 ? Hen : piece;
                ulong next = Put(Put(key, from, 0), to, moved);
                if (Attacked(next, piece == King ? to : king, 1)) continue;
                if (captured != 0) next += HandUnit(0, (captured & 7) == Hen ? Pawn : captured & 7);
                moves[count] = from * 12 + to;
                children[count++] = Flip(next);
            }
        }
        for (int kind = Rook; kind <= Pawn; kind++) {
            if (Hand(key, 0, kind) == 0) continue;
            int destinations = empty & 0x777;
            while (destinations != 0) {
                int to = First[destinations]; destinations &= destinations - 1;
                ulong next = Put(key - HandUnit(0, kind), to, kind);
                if (Attacked(next, king, 1)) continue;
                moves[count] = (12 + kind - Rook) * 12 + to;
                children[count++] = Flip(next);
            }
        }
        if (count == 0) terminal = -1;
        return count;
    }

    // Invert geometry, drops, captures and promotion. Membership in the forward
    // reachable set removes illegal predecessors. A reachable child has already
    // established that the moving side's king is safe after the move.
    static int Parents(ulong child, ulong[] parents)
    {
        ulong key = Flip(child);
        int empty = 0, count = 0;
        for (int sq = 0; sq < 12; sq++) if (Piece(key, sq) == 0) empty |= 1 << sq;
        for (int to = 0; to < 12; to++) {
            int piece = Piece(key, to);
            if (piece == 0 || piece >= 8) continue;
            ulong without = Put(key, to, 0);
            if (piece >= Rook && piece <= Pawn && to % 4 != 3 && Hand(key, 0, piece) < 2)
                parents[count++] = without + HandUnit(0, piece);
            if (piece == Pawn && to % 4 == 3) continue;
            int origins = Origin[piece, to] & empty;
            int unpromoted = piece == Hen && to % 4 == 3 ? Origin[Pawn, to] & empty : 0;
            while ((origins | unpromoted) != 0) {
                int from = First[origins | unpromoted], bit = 1 << from;
                int kind = (origins & bit) != 0 ? piece : Pawn;
                if (kind == piece) origins ^= bit; else unpromoted ^= bit;
                ulong prior = Put(without, from, kind);
                parents[count++] = prior;
                for (int capture = Rook; capture <= Pawn; capture++) if (Hand(key, 0, capture) != 0) {
                    ulong restored = prior - HandUnit(0, capture);
                    parents[count++] = Put(restored, to, capture + 8);
                    if (capture == Pawn) parents[count++] = Put(restored, to, Hen + 8);
                }
            }
        }
        return count;
    }

    static ulong Start()
    {
        ulong key = 0;
        key = Put(key, 0, Bishop); key = Put(key, 4, King); key = Put(key, 5, Pawn); key = Put(key, 8, Rook);
        key = Put(key, 11, Bishop + 8); key = Put(key, 7, King + 8); key = Put(key, 6, Pawn + 8); key = Put(key, 3, Rook + 8);
        if (Flip(key) != key) throw new InvalidOperationException("Both starting sides must be symmetric");
        return key;
    }

    static short Get(ulong key)
    {
        int pair, rank = Index(key, out pair);
        return rank < 0 || Status[pair] == null ? (short)0 : Status[pair][rank];
    }

    static int Solve(string output, int limit)
    {
        if (File.Exists(output)) throw new IOException("Output already exists");
        var watch = Stopwatch.StartNew();
        var frontier = new Queue<ulong>();
        var solved = new Queue<ulong>();
        var children = new ulong[180]; var moves = new int[180];
        ulong start = Start();
        int reached = 0, expanded = 0, wins = 0, losses = 0, maxPlies = 0;
        long edges = 0;
        Action<ulong> visit = delegate(ulong key) {
            int pair, index = Index(key, out pair);
            if (index < 0) throw new InvalidOperationException("Reachable kings are adjacent");
            if (Status[pair] == null) Status[pair] = new short[Stride];
            if (Status[pair][index] != 0) return;
            Status[pair][index] = 255;
            frontier.Enqueue(key);
            reached++;
        };
        visit(start);
        while (frontier.Count != 0) {
            ulong key = frontier.Dequeue();
            int pair, index = Index(key, out pair), terminal;
            int count = Generate(key, children, moves, out terminal);
            if (terminal != 0) {
                Status[pair][index] = (short)(RankBase * terminal);
                solved.Enqueue(key);
                if (terminal > 0) wins++; else losses++;
            } else {
                Status[pair][index] = (short)count;
                for (int i = 0; i < count; i++) visit(children[i]);
                edges += count;
            }
            expanded++;
            if (expanded % 5000000 == 0)
                Console.WriteLine("reachable expanded={0} discovered={1} queued={2} seconds={3:F1}", expanded, reached, frontier.Count, watch.Elapsed.TotalSeconds);
            if (limit > 0 && reached >= limit) {
                Console.WriteLine("limited expanded={0} discovered={1} seconds={2:F1}", expanded, reached, watch.Elapsed.TotalSeconds);
                return 0;
            }
        }
        Console.WriteLine("closed positions={0} edges={1} terminals={2} seconds={3:F1}", reached, edges, solved.Count, watch.Elapsed.TotalSeconds);
        var predecessors = new ulong[360];
        int resolved = 0;
        while (solved.Count != 0) {
            ulong child = solved.Dequeue();
            short value = Get(child);
            int distance = Math.Abs((int)value) + 1;
            if (distance > short.MaxValue) throw new InvalidOperationException("Proof rank overflow");
            int count = Parents(child, predecessors);
            for (int i = 0; i < count; i++) {
                ulong parent = predecessors[i];
                int pair, index = Index(parent, out pair);
                if (index < 0 || Status[pair] == null) continue;
                short pending = Status[pair][index];
                if (pending <= 0 || pending >= RankBase) continue;
                if (value > 0 && pending > 1) { Status[pair][index]--; continue; }
                Status[pair][index] = (short)(value > 0 ? -distance : distance);
                if (value > 0) losses++; else wins++;
                maxPlies = Math.Max(maxPlies, distance - RankBase);
                solved.Enqueue(parent);
            }
            if (++resolved % 5000000 == 0)
                Console.WriteLine("retrograde resolved={0} queue={1} seconds={2:F1}", resolved, solved.Count, watch.Elapsed.TotalSeconds);
        }
        Console.WriteLine("result positions={0} wins={1} draws={2} losses={3} maxPlies={4} start={5} seconds={6:F1}",
            reached, wins, reached - wins - losses, losses, maxPlies, Format(Get(start)), watch.Elapsed.TotalSeconds);
        int ignored, actions = Generate(start, children, moves, out ignored);
        for (int i = 0; i < actions; i++) {
            short child = Get(children[i]);
            short result = Math.Abs((int)child) >= RankBase ? (short)(-child - Math.Sign(child)) : child;
            Console.WriteLine("firstMove {0} {1}", moves[i], Format(result));
        }

        // Dense values support direct seeks without constructing a runtime map.
        // Write a private temporary file and expose it only after the full solve.
        string partial = output + ".partial";
        using (var file = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1048576)) {
            byte[] header = System.Text.Encoding.ASCII.GetBytes(Magic);
            file.Write(header, 0, header.Length);
            var block = new byte[Stride * sizeof(short)];
            for (int pair = 0; pair < PairCount; pair++) {
                if (Status[pair] != null) Buffer.BlockCopy(Status[pair], 0, block, 0, block.Length);
                else Array.Clear(block, 0, block.Length);
                file.Write(block, 0, block.Length);
            }
        }
        File.Move(partial, output);
        return 0;
    }

    static string Format(short value)
    {
        return value == 0 ? "unknown" : value >= RankBase ? "win/" + (value - RankBase)
            : value <= -RankBase ? "loss/" + (-value - RankBase) : "draw";
    }

    // Verify a nonloss certificate using forward edges only, independently of
    // the reverse propagation that built the table. The extra bit preserves
    // Red's physical identity after turn normalization.
    static void ProveRed(string path)
    {
        const ulong RedTurn = 1UL << 60;
        long expectedLength = Magic.Length + (long)PairCount * Stride * 2;
        using (var file = File.OpenRead(path)) {
            var header = new byte[Magic.Length];
            if (file.Read(header, 0, header.Length) != header.Length || System.Text.Encoding.ASCII.GetString(header) != Magic
                || file.Length != expectedLength) throw new IOException("Invalid full tablebase");
        }
        using (var mapped = MemoryMappedFile.CreateFromFile(path, FileMode.Open, null, 0, MemoryMappedFileAccess.Read))
        using (var table = mapped.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read)) {
            var frontier = new Queue<ulong>();
            var visited = new uint[2 * PairCount][];
            var children = new ulong[180]; var moves = new int[180];
            long positions = 0, blueEdges = 0, redEdges = 0, excludedRedEdges = 0, redWins = 0;
            var watch = Stopwatch.StartNew();
            Action<ulong, int, int, bool> visit = delegate(ulong key, int pair, int rank, bool redToMove) {
                int slot = pair + (redToMove ? PairCount : 0);
                if (visited[slot] == null) visited[slot] = new uint[(Stride + 31) / 32];
                uint mask = 1U << (rank % 32);
                if ((visited[slot][rank / 32] & mask) != 0) return;
                visited[slot][rank / 32] |= mask;
                frontier.Enqueue(key | (redToMove ? RedTurn : 0));
            };
            ulong start = Start();
            int startPair, startRank = Index(start, out startPair);
            short initial = table.ReadInt16(Magic.Length + ((long)startPair * Stride + startRank) * 2);
            if (initial <= 0 || initial >= RankBase) throw new InvalidOperationException("Start is not a draw");
            visit(start, startPair, startRank, false);
            while (frontier.Count != 0) {
                ulong encoded = frontier.Dequeue(), key = encoded & ~RedTurn;
                bool redToMove = (encoded & RedTurn) != 0;
                int terminal, count = Generate(key, children, moves, out terminal);
                if (terminal != 0) {
                    if ((terminal > 0) != redToMove) throw new InvalidOperationException("Certificate permits a Blue win");
                    redWins++;
                } else {
                    int kept = 0;
                    for (int i = 0; i < count; i++) {
                        ulong child = children[i];
                        int pair, rank = Index(child, out pair);
                        if (rank < 0) throw new InvalidOperationException("Invalid reachable child");
                        short value = table.ReadInt16(Magic.Length + ((long)pair * Stride + rank) * 2);
                        if (value == 0) throw new InvalidOperationException("Certificate reaches an unclassified position");
                        if (redToMove && value >= RankBase) { excludedRedEdges++; continue; }
                        if (!redToMove && value <= -RankBase) throw new InvalidOperationException("Blue can force Red into a table loss");
                        kept++;
                        if (redToMove) redEdges++; else blueEdges++;
                        visit(child, pair, rank, !redToMove);
                    }
                    if (kept == 0) throw new InvalidOperationException("Red has no certified reply");
                }
                if (++positions % 5000000 == 0)
                    Console.WriteLine("proof progress positions={0} queued={1} seconds={2:F1}", positions, frontier.Count, watch.Elapsed.TotalSeconds);
            }
            Console.WriteLine("proved red-nonloss positions={0} blueEdges={1} redEdges={2} excludedRedEdges={3} redWinTerminals={4} seconds={5:F1}",
                positions, blueEdges, redEdges, excludedRedEdges, redWins, watch.Elapsed.TotalSeconds);
        }
    }

    static void Inspect(string path)
    {
        using (var file = path == null ? null : File.OpenRead(path)) {
            if (file != null) {
                var header = new byte[Magic.Length];
                if (file.Read(header, 0, header.Length) != header.Length || System.Text.Encoding.ASCII.GetString(header) != Magic
                    || file.Length != Magic.Length + (long)PairCount * Stride * 2) throw new IOException("Invalid full tablebase");
            }
            var children = new ulong[180]; var moves = new int[180]; var parents = new ulong[360];
            string line;
            while ((line = Console.ReadLine()) != null) {
                ulong key = ulong.Parse(line, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                int pair, rank = Index(key, out pair), terminal;
                if (file == null) {
                    int count = Generate(key, children, moves, out terminal);
                    Console.Write("{0} {1} {2}", pair, rank, terminal);
                    for (int i = 0; i < count; i++) {
                        int size = Parents(children[i], parents), matches = 0;
                        for (int j = 0; j < size; j++) if (parents[j] == key) matches++;
                        if (matches != 1) throw new InvalidOperationException("Forward edge does not have exactly one inverse");
                        Console.Write(" {0}:{1:x}", moves[i], children[i]);
                    }
                    Console.WriteLine();
                } else if (rank < 0) Console.WriteLine("unknown");
                else {
                    file.Position = Magic.Length + ((long)pair * Stride + rank) * 2;
                    Console.WriteLine(Format((short)(file.ReadByte() | (file.ReadByte() << 8))));
                }
            }
        }
    }

    static int Main(string[] args)
    {
        try {
            if (args.Length == 1 && args[0] == "rules") Inspect(null);
            else if (args.Length == 2 && args[0] == "probe") Inspect(args[1]);
            else if (args.Length == 2 && args[0] == "prove-red") ProveRed(args[1]);
            else if ((args.Length == 2 || args.Length == 3) && args[0] == "solve")
                return Solve(args[1], args.Length == 3 ? int.Parse(args[2]) : 0);
            else throw new ArgumentException("Use solve OUTPUT [VISIT_LIMIT], rules, probe TABLE, or prove-red TABLE");
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
