// Depth-first proof-number search over a path-specific tree (no transpositions).
// A "loss" only disproves this attacker's forced win; a draw is also a loss of
// that proposition. Callers must not interpret it as an opponent winning proof.
const INF = Infinity, LIMIT = Symbol('DFPN node limit');
const fresh = () => ({ pn: 1, dn: 1, children: null, cutoff: false });

/** Prove an attacker win while restoring the caller's position and history. */
export function solveWin(position, attacker, { maxNodes = 1000, maxDepth = 32, check = () => {} } = {}) {
  if (attacker !== 0 && attacker !== 1) throw new Error('Invalid DFPN attacker');
  const nodeLimit = Number.isFinite(maxNodes) ? Math.max(0, Math.floor(maxNodes)) : 1000;
  const depthLimit = Number.isFinite(maxDepth) ? Math.max(0, Math.floor(maxDepth)) : 32;
  const root = fresh();
  let nodes = 0;

  function update(node, orNode) {
    if (orNode) {
      node.pn = Math.min(...node.children.map(child => child.pn));
      node.dn = node.children.reduce((sum, child) => sum + child.dn, 0);
      // Disproving an OR requires disproving every child. Any depth-blocked
      // child therefore prevents a genuine game-theoretic disproof.
      node.cutoff = node.dn === 0 && node.children.some(child => child.cutoff);
    } else {
      node.pn = node.children.reduce((sum, child) => sum + child.pn, 0);
      node.dn = Math.min(...node.children.map(child => child.dn));
      // Disproving an AND requires just one genuine disproof. A different
      // blocked child must not conceal an independently conclusive defense.
      node.cutoff = node.dn === 0 && !node.children.some(child => child.dn === 0 && !child.cutoff);
    }
  }

  function dfpn(node, phi, delta, depth) {
    check();
    if (nodes >= nodeLimit) throw LIMIT;
    nodes++;
    const orNode = position.turn === attacker;
    if (node.children === null) {
      const actions = position.actions(), winner = position.winner(actions);
      if (winner !== null) {
        node.pn = winner === attacker ? 0 : INF;
        node.dn = winner === attacker ? INF : 0;
        return;
      }
      if (depth >= depthLimit) {
        // Close this finite-depth proposition, but tag the disproof as blocked.
        // The tag follows precisely the disproof dependency above. It can never
        // become a public "loss" or contribute to a winning proof. Closing the
        // frontier once prevents repeatedly selecting an unexpandable leaf.
        node.pn = INF; node.dn = 0; node.cutoff = true;
        return;
      }
      node.children = actions.map(move => ({ ...fresh(), move }));
      update(node, orNode);
    }
    while (node.pn < phi && node.dn < delta) {
      let best, primary = INF, second = INF;
      for (const child of node.children) {
        const value = orNode ? child.pn : child.dn;
        if (!best || value < primary) { second = primary; primary = value; best = child; }
        else if (value < second) second = value;
      }
      // Genuine DFPN thresholds: second-best+1 for the minimum dimension,
      // and the parent's remaining sum allowance for the other dimension.
      const childPhi = orNode ? Math.min(phi, second + 1) : phi - node.pn + best.pn;
      const childDelta = orNode ? delta - node.dn + best.dn : Math.min(delta, second + 1);
      const undo = position.make(best.move);
      try { dfpn(best, childPhi, childDelta, depth + 1); }
      finally { position.unmake(undo); }
      update(node, orNode);
    }
  }

  try { dfpn(root, INF, INF, 0); }
  catch (error) { if (error !== LIMIT) throw error; }
  const status = root.pn === 0 ? 'win' : root.dn === 0 && !root.cutoff ? 'loss' : 'unknown';
  const move = status === 'win' && position.turn === attacker ? root.children?.find(child => child.pn === 0)?.move : undefined;
  return { status, move, nodes };
}
