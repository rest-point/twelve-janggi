export function think({ legalActions, seed }) {
  let value = seed >>> 0;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  return { action: legalActions[(value >>> 0) % legalActions.length] };
}
